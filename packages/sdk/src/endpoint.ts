/**
 * Where a Bureau lives, and how to talk to it — the vendor-neutral contract
 * shared by every surface that consumes a provisioned Bureau:
 *
 *   • a runtime ADAPTER (e2b sandbox, Box, a local daemon) produces a
 *     `BureauEndpoint` after it brings a Bureau up,
 *   • `createHttpTransport({ baseUrl: endpoint.mcpBase })` drives its tools,
 *   • the watch viewer opens `endpoint.watchUrl(tab)` for the live screencast.
 *
 * The two URLs are the whole surface a Bureau exposes off-box: MCP over HTTP
 * (POST /mcp) and the screencast WebSocket (/watch/<tab>). Building them in one
 * place keeps the scheme/port logic out of every call site — a cloud host is
 * `https`/`wss`, a local one `http`/`ws`, and nothing downstream has to know.
 *
 * Vendor-neutral by design: no `e2b`/`box`/app imports. A server-side adapter
 * imports its provider SDK and returns this shape; this module never does.
 */

import { createHttpTransport, type BureauTransport } from "./transport.js"

/**
 * A reachable Bureau, expressed as the two things a consumer actually needs: a
 * `transport()` for MCP tool calls and a `watchUrl(tab)` for the screencast.
 *
 * Both shapes are honored by BOTH backends behind the same interface:
 *   • cloud (e2b)  → transport posts directly to `https://<host>/mcp`, watch is
 *                    `wss://<host>/watch/<tab>` — `mcpBase` is the public origin.
 *   • local daemon → transport forwards over the reverse tunnel (callImportedMcp
 *                    + daemonId), watch is `wss://<tunnel>/me/daemon/watch/<tab>`.
 *                    No public origin exists, so `mcpBase` is absent.
 * Dispatch keys off `transport()`, never a raw URL, so it is kind-agnostic.
 */
export interface BureauEndpoint {
  /** MCP tool transport — `callTool(name, args)`. The canonical dispatch seam. */
  transport(opts?: BureauTransportOptions): BureauTransport
  /** Live screencast socket for one tab — `wss://…/watch/<tab>` (+ stream opts). */
  watchUrl(tabId: string, opts?: WatchUrlOptions): string
  /** Public MCP-over-HTTP base, when one exists (cloud). Absent for tunnel-backed. */
  readonly mcpBase?: string
  /** The origin both URLs derive from (diagnostics / equality). */
  readonly origin: string
}

export interface BureauTransportOptions {
  /** Non-browser hosts pass a fetch impl; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export interface WatchUrlOptions {
  /** Frame encoding. Default server-side: jpeg. */
  format?: "jpeg" | "png"
  /** JPEG quality 1..100. */
  quality?: number
  /** Target frames per second 1..30. */
  fps?: number
}

/**
 * Build a `BureauEndpoint` from an origin. Pass a bare `host[:port]` (an e2b
 * proxy host, a tunnel host) and it defaults to TLS — that's the cloud case and
 * the safe default; pass a full `http://…`/`ws://…` origin for a local Bureau
 * and the scheme is honored. The watch scheme tracks the MCP scheme (https→wss,
 * http→ws), so one input decides both.
 */
export function bureauEndpoint(originOrHost: string): BureauEndpoint {
  const origin = normalizeOrigin(originOrHost)
  const secure = origin.startsWith("https://")
  const wsBase =
    (secure ? "wss://" : "ws://") + origin.replace(/^https?:\/\//, "")
  const mcpBase = origin.replace(/\/+$/, "")
  return {
    mcpBase,
    origin,
    transport(opts) {
      return createHttpTransport({
        baseUrl: mcpBase,
        ...(opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      })
    },
    watchUrl(tabId, opts) {
      const q = new URLSearchParams()
      if (opts?.format) q.set("format", opts.format)
      if (opts?.quality != null) q.set("quality", String(opts.quality))
      if (opts?.fps != null) q.set("fps", String(opts.fps))
      const qs = q.toString()
      return `${wsBase}/watch/${encodeURIComponent(tabId)}${qs ? `?${qs}` : ""}`
    },
  }
}

function normalizeOrigin(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "")
  if (/^https?:\/\//.test(trimmed)) return trimmed
  if (/^wss:\/\//.test(trimmed)) return "https://" + trimmed.slice(6)
  if (/^ws:\/\//.test(trimmed)) return "http://" + trimmed.slice(5)
  // Bare host[:port] → TLS (the cloud default).
  return "https://" + trimmed
}

/**
 * A Bureau brought up by a runtime adapter: where it lives plus its lifecycle
 * handles. `stop` tears it down; `pause`/`resume` are present only for backends
 * that snapshot (Box, e2b paused sandboxes) and absent for ephemeral ones.
 */
export interface ProvisionedBureau {
  /** Adapter-scoped id of the underlying sandbox/box/daemon. */
  readonly id: string
  /** Reachable endpoint (MCP base + watch-socket builder). */
  readonly endpoint: BureauEndpoint
  /** Tear the Bureau down and release its resources. */
  stop(): Promise<void>
  /** Snapshot + suspend billing where the backend supports it. */
  pause?(): Promise<void>
  /** Resume a paused Bureau, returning its (possibly new) endpoint. */
  resume?(): Promise<ProvisionedBureau>
}

/**
 * The swappable seam: one method that brings a Bureau up and hands back a
 * `ProvisionedBureau`. e2b (ephemeral, per-tenant), Box (persistent guild
 * workspace), and local register as adapters behind this port — the consumer
 * picks by scope, never by `if (kind === …)`.
 */
export interface BureauRuntime {
  /** Stable kind key for the adapter registry (e.g. "e2b", "box", "local"). */
  readonly kind: string
  /** Bring a Bureau up for the given tenant scope. */
  provision(input: BureauProvisionInput): Promise<ProvisionedBureau>
}

export interface BureauProvisionInput {
  /** Tenant the Bureau is scoped to (guild, user, workspace — adapter's call). */
  readonly tenantId: string
  /** Hard ceiling before the backend reaps an idle Bureau, if it supports one. */
  readonly timeoutMs?: number
  /**
   * Opaque environment injected into the Bureau at boot — the CROSS-DOCK seam.
   * The runtime stays app-agnostic: it forwards these verbatim to the backend
   * (e.g. e2b `Sandbox.create({ envs })`), and the host app decides what they
   * mean. A host uses it to ship scoped callback credentials so an ephemeral
   * cloud Bureau can materialise the host's browser sessions, without the
   * adapter ever importing anything host-specific.
   */
  readonly env?: Readonly<Record<string, string>>
}
