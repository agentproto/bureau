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
import { runAsDevice, type DeviceIdentity } from "./device-context.js"
import type { LiveViewHandler } from "./live-view.js"

/**
 * What `authorize` decides for a `/mcp` request. `true`/`false` is enough for a
 * flavour with no notion of a device (the studio's loopback-open default); the
 * OSS default returns the paired device so per-device grants can key on it.
 */
export type AuthDecision =
  | boolean
  | { ok: boolean; device?: DeviceIdentity }

/**
 * Authorize a request to `/mcp`. The OSS flavour's authorize is AIP-59
 * pairing (`createBureauPairing().authorize`): a device bearer in
 * `Authorization`. There is no static token scheme. A plugin may supply its own
 * (`BureauPlugin.authorize`); `/health` is never gated by this.
 */
export type Authorize = (req: IncomingMessage) => AuthDecision | Promise<AuthDecision>

function isLoopbackSocket(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? ""
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
}

/** Loopback-only authorize. Not a default anywhere: a flavour that keeps its
 *  loopback-open contract (the studio) opts in by supplying it explicitly. */
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

const LIVE_PREFIX = "/live/"

const isLivePath = (url: string | undefined): boolean => (url ?? "").split("?")[0]?.startsWith(LIVE_PREFIX) === true

/** `/live/<session>`: 405 for anything but GET, then Host, then `authorize` (401), then the view. No request body is ever read. */
function handleLive(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  authorize: Authorize,
  liveView: LiveViewHandler
): void {
  const fail = (status: number, error: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json", ...extra })
    res.end(JSON.stringify({ error }))
  }
  if (req.method !== "GET") {
    req.resume()
    fail(405, "method not allowed", { allow: "GET" })
    return
  }
  if (!validHost(req, port)) {
    fail(403, "invalid host")
    return
  }
  const segments = (req.url ?? "").split("?")[0]!.slice(LIVE_PREFIX.length).split("/")
  let session: string | undefined
  try {
    session = segments.length === 1 && segments[0] !== "" ? decodeURIComponent(segments[0]!) : undefined
  } catch {
    session = undefined
  }
  Promise.resolve(authorize(req))
    .then(decision => {
      const ok = typeof decision === "boolean" ? decision : decision.ok
      if (!ok) return fail(401, "unauthorized", { "www-authenticate": 'Bearer realm="bureau"' })
      if (session === undefined) return fail(404, "not found")
      const device = typeof decision === "boolean" ? undefined : decision.device
      return liveView(req, res, session, device)
    })
    .catch(() => {
      if (!res.headersSent) fail(500, "internal error")
      else res.end()
    })
}

/** Start the Bureau HTTP server: POST /mcp, GET /health, + any extra routes.
 *
 * `extraRoutes` is a fall-through handler tried BEFORE the 404 (and before MCP):
 * it returns `true` when it owned the request. P5a+ uses it for the
 * loopback-guarded `/cred-capture/:token` credential page — the only
 * secret-accepting surface; its own loopback guard lives in that handler.
 *
 * `/mcp` is gated by a Host check (DNS-rebinding defense) and `authorize`,
 * which the caller must supply (pairing for the OSS flavour). `/health` is
 * NEVER gated: it stays the open liveness probe (`{ok:true,tools:N}`,
 * additive fields only). */
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
  /** Authorize a `/mcp` request. Required: there is no open default. */
  authorize: Authorize
  /** Extra JSON fields for `/health`, computed per request. Additive only: `ok`
   *  and `tools` are always Bureau's own, and the status stays 200 whatever the
   *  browser backend reports. */
  healthExtras?: () => Record<string, unknown>
  /** Read-only `GET /live/<session>` stream. Runs after the Host check and `authorize`, and only ever for GET. */
  liveView?: LiveViewHandler
}): HttpServer {
  const { entries, extraRoutes, rateLimitDisabled, port, authorize, healthExtras, liveView } = opts
  const handleMcp = createMcpHandler(entries, { rateLimitDisabled })

  return createServer((req, res) => {
    if (liveView && isLivePath(req.url)) {
      handleLive(req, res, port, authorize, liveView)
      return
    }
    if (extraRoutes?.(req, res)) return
    if (req.method === "GET" && req.url?.startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" })
      const { ok: _ok, tools: _tools, ...extras } = healthExtras?.() ?? {}
      res.end(JSON.stringify({ ok: true, tools: entries.length, ...extras }))
      return
    }
    if (req.method === "POST" && req.url?.startsWith("/mcp")) {
      if (!validHost(req, port)) {
        res.writeHead(403, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid host" }))
        return
      }
      Promise.resolve(authorize(req))
        .then(decision => {
          const ok = typeof decision === "boolean" ? decision : decision.ok
          if (!ok) {
            // No detail on why: a missing, malformed, unknown and revoked
            // credential are indistinguishable to the caller.
            res.writeHead(401, {
              "content-type": "application/json",
              "www-authenticate": 'Bearer realm="bureau"',
            })
            res.end(JSON.stringify({ error: "unauthorized" }))
            return
          }
          const device =
            typeof decision === "boolean" ? undefined : decision.device
          return device
            ? runAsDevice(device, () => handleMcp(req, res))
            : handleMcp(req, res)
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
