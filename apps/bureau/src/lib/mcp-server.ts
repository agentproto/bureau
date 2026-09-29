/**
 * MCP server factory — wraps a frozen McpEntry[] catalogue in an MCP Server
 * and produces a per-request HTTP handler.
 *
 * Design note: a fresh MCP Server + transport pair is created for EVERY POST
 * /mcp request (stateless boundary). This is intentional — the MCP SDK's
 * Server instance holds per-connection lifecycle state, and using the same
 * instance for concurrent requests would interleave their response streams.
 * Shared state (driver pool, job registries, the catalogue itself) lives in
 * the closed-over `entries` array and the maps built at startup, NOT in the
 * Server instance, so statelessness at the request boundary is free.
 */

import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import type { McpEntry } from "../mcp-tool.js"
import { createRateLimiter, LIMITS, type RateLimiter } from "./rate-limit.js"

/**
 * Authorize a request to `/mcp` — the seam a later lane (LP2, pairing) plugs
 * a real bearer/pairing check into. The default here (`allowLoopback`) MUST
 * stay the only implementation in THIS lane: PLAN-FINAL.md L0 is explicit
 * that no static token/env-token scheme belongs here, only pairing (LP2)
 * ever replaces this default. `/health` is never gated by this — it stays
 * open (`{ok:true,tools:N}`, additive fields only).
 */
export type Authorize = (req: IncomingMessage) => boolean | Promise<boolean>

function isLoopbackSocket(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ""
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
}

/** Default `authorize`: allow only callers on the loopback socket. */
export const allowLoopback: Authorize = req => isLoopbackSocket(req)

/**
 * DNS-rebinding defense, modelled on (not imported from — a non-daemon host
 * must not pull in `@agentproto/runtime`) `TS/packages/runtime/src/http-server.ts`'s
 * `validateHost`: a page at `evil.com` that resolves to `127.0.0.1` still
 * sends `Host: evil.com:<port>` — a request that reached us on the loopback
 * socket must carry a loopback `Host`, or it's refused. Non-loopback traffic
 * (skipped here) is `authorize()`'s job.
 */
function loopbackHosts(port: number): ReadonlySet<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
}

function validHost(req: IncomingMessage, port: number): boolean {
  if (!isLoopbackSocket(req)) return true
  const host = (req.headers.host ?? "").toLowerCase()
  return loopbackHosts(port).has(host)
}

function buildMcpServer(
  entries: McpEntry[],
  byName: Map<string, McpEntry>,
  limiter: RateLimiter
): Server {
  const server = new Server(
    { name: "bureau", version: "0.1.0" },
    { capabilities: { tools: {} } }
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: entries.map(
      (e): Tool => ({
        name: e.name,
        description: e.description,
        inputSchema: e.jsonSchema,
      })
    ),
  }))
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name } = req.params
    const entry = byName.get(name)
    if (!entry) throw new Error(`bureau: unknown tool "${name}"`)
    // Gate BEFORE dispatch — a runaway agent spamming one tool spends its own
    // bucket and gets back a normal (non-throwing) MCP result it can read and
    // back off from, instead of an opaque transport error it tends to retry
    // harder against.
    const gate = limiter.take(name)
    if (!gate.ok) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              throttled: true,
              tool: name,
              retryAfterMs: gate.retryAfterMs,
              limit: gate.limit,
            }),
          },
        ],
      }
    }
    return entry.call(req.params.arguments ?? {})
  })
  return server
}

/** Create the POST /mcp handler from a frozen entry catalogue.
 *
 * `limiter` defaults to an internal, module-owned `RateLimiter` (built from
 * the `LIMITS` table) so standalone use still works without a caller wiring
 * one up. Pass one in to share it across handlers, inject a fake clock for
 * tests, or set `rateLimitDisabled` (from the typed env seam — never raw
 * `process.env` here) to kill-switch throttling entirely. */
export function createMcpHandler(
  entries: McpEntry[],
  opts: { limiter?: RateLimiter; rateLimitDisabled?: boolean } = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const byName = new Map<string, McpEntry>(entries.map(e => [e.name, e]))
  // Instantiated ONCE, in this create-once scope — same lifetime as `byName`.
  // A per-request limiter would reset every bucket to full on every call,
  // silently defeating the whole point (see rate-limit.ts's file header).
  const limiter =
    opts.limiter ??
    createRateLimiter(LIMITS, { disabled: opts.rateLimitDisabled ?? false })

  return async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined
    const server = buildMcpServer(entries, byName, limiter)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on("close", () => {
      // Wrap in try/catch — server.close() can throw synchronously when the
      // transport is already gone, and the .catch() only covers promise
      // rejections, not synchronous throws in the event-handler context
      // (salvage: refs/salvage/stash/2026-07-07-33, crash safety net).
      try {
        transport.close().catch(() => {})
      } catch {
        /* already closed */
      }
      try {
        server.close().catch(() => {})
      } catch {
        /* already closed */
      }
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}

/** Start the Bureau HTTP server: POST /mcp, GET /health, + any extra routes.
 *
 * `extraRoutes` is a fall-through handler tried BEFORE the 404 (and before MCP):
 * it returns `true` when it owned the request. P5a+ uses it for the
 * loopback-guarded `/cred-capture/:token` credential page — the only
 * secret-accepting surface; its own loopback guard lives in that handler.
 *
 * `/mcp` is gated by a Host check (DNS-rebinding defense) and `authorize`
 * (default: loopback-only — F1/Decision 5). `/health` is NEVER gated — it
 * stays the open liveness probe (`{ok:true,tools:N}`, additive fields only). */
export function createBureauHttpServer(opts: {
  entries: McpEntry[]
  extraRoutes?: (req: IncomingMessage, res: ServerResponse) => boolean
  /** Kill-switch for the per-tool rate limiter — thread the resolved value
   *  from the typed env seam (`boolEnv("BUREAU_RATELIMIT_DISABLED")` in
   *  lib/args.ts), never a raw `process.env` read here. */
  rateLimitDisabled?: boolean
  /** The port this server will `.listen()` on — needed for the loopback Host
   *  allowlist. Must match the actual listen port or the Host check rejects
   *  every loopback request. */
  port: number
  /** Authorize a `/mcp` request; default `allowLoopback`. A later lane (LP2)
   *  replaces this with pairing — never add a static token scheme here. */
  authorize?: Authorize
}): HttpServer {
  const { entries, extraRoutes, rateLimitDisabled, port } = opts
  const authorize = opts.authorize ?? allowLoopback
  const handleMcp = createMcpHandler(entries, { rateLimitDisabled })

  return createServer((req, res) => {
    if (extraRoutes?.(req, res)) return
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, tools: entries.length }))
      return
    }
    if (req.method === "POST" && req.url?.startsWith("/mcp")) {
      if (!validHost(req, port)) {
        res.writeHead(403, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid host" }))
        return
      }
      Promise.resolve(authorize(req))
        .then(ok => {
          if (!ok) {
            res.writeHead(401, { "content-type": "application/json" })
            res.end(JSON.stringify({ error: "unauthorized" }))
            return
          }
          return handleMcp(req, res)
        })
        .catch(err => {
          if (!res.headersSent)
            res.writeHead(500, { "content-type": "application/json" })
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            })
          )
        })
      return
    }
    res.writeHead(404)
    res.end()
  })
}
