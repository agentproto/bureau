/**
 * Per-browser-minute usage metering (a business hook; OSS ships the port, a
 * noop default and a JSONL file sink, a plugin may supply its own meter).
 *
 * The tracker turns the supervisor lifecycle (one browser instance) and the
 * active-driver pool (one live session per id) into `start`, `heartbeat` and
 * `stop` events. An event carries only ids, the browser id, a duration and the
 * paired device fingerprint: never a URL, a query string, a cookie or a token.
 */

import { createHash } from "node:crypto"
import { appendFileSync, chmodSync, mkdirSync, statSync } from "node:fs"
import { dirname } from "node:path"
import type { BrowserUsageEvent, UsageEvent, UsageMeter } from "../plugin.js"

export interface UsageClock {
  now(): number
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export const systemUsageClock: UsageClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms)
    handle.unref()
    return handle
  },
  clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
}

export const DEFAULT_HEARTBEAT_MS = 60_000

export interface BrowserUsageTracker {
  /** The supervised instance is running. Idempotent for the same id; a new id closes the old one first. */
  instanceStarted(instanceId: string): void
  instanceStopped(): void
  sessionStarted(sessionId: string, deviceFingerprint?: string): void
  sessionStopped(sessionId: string): void
  /** Close every open instance and session (shutdown). */
  stopAll(): void
}

export const noopUsageTracker: BrowserUsageTracker = {
  instanceStarted: () => {},
  instanceStopped: () => {},
  sessionStarted: () => {},
  sessionStopped: () => {},
  stopAll: () => {},
}

const SAFE_ID = /^[\w.@:-]{1,128}$/

/** Ids come from callers; anything that is not a plain token is replaced by a short hash. */
export function safeUsageId(id: string): string {
  return SAFE_ID.test(id) ? id : `h_${createHash("sha256").update(id).digest("hex").slice(0, 16)}`
}

export interface BrowserUsageTrackerOptions {
  meter: UsageMeter
  /** The browser id (provider id) being metered. */
  browser: string
  clock?: UsageClock
  /** Heartbeat interval (default 60 s, one per browser minute). */
  heartbeatMs?: number
}

interface Open {
  scope: "instance" | "session"
  key: string
  startedAt: number
  sessionId?: string
  deviceFingerprint?: string
}

export function createBrowserUsageTracker(opts: BrowserUsageTrackerOptions): BrowserUsageTracker {
  const clock = opts.clock ?? systemUsageClock
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const open = new Map<string, Open>()
  let timer: unknown
  let instanceId: string | undefined

  const emit = (type: BrowserUsageEvent["type"], o: Open): void => {
    const now = clock.now()
    const event: BrowserUsageEvent = {
      kind: "browser-minute",
      type,
      scope: o.scope,
      browser: opts.browser,
      ...(instanceId !== undefined ? { instanceId } : {}),
      ...(o.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
      ...(o.deviceFingerprint !== undefined ? { deviceFingerprint: o.deviceFingerprint } : {}),
      at: new Date(now).toISOString(),
      durationMs: type === "start" ? 0 : Math.max(0, now - o.startedAt),
    }
    try {
      const result = opts.meter.browser?.(event)
      if (result instanceof Promise) result.catch(() => {})
    } catch {
      // A broken meter must never take the browser down.
    }
  }

  const ensureTimer = (): void => {
    if (timer !== undefined || open.size === 0) return
    timer = clock.setInterval(() => {
      for (const o of open.values()) emit("heartbeat", o)
    }, heartbeatMs)
  }
  const releaseTimer = (): void => {
    if (timer === undefined || open.size > 0) return
    clock.clearInterval(timer)
    timer = undefined
  }

  const begin = (key: string, o: Omit<Open, "key" | "startedAt">): void => {
    if (open.has(key)) return
    const entry: Open = { ...o, key, startedAt: clock.now() }
    open.set(key, entry)
    emit("start", entry)
    ensureTimer()
  }
  const end = (key: string): void => {
    const entry = open.get(key)
    if (!entry) return
    emit("stop", entry)
    open.delete(key)
    releaseTimer()
  }

  const closeSessions = (): void => {
    for (const key of [...open.keys()]) if (key.startsWith("session:")) end(key)
  }

  const tracker: BrowserUsageTracker = {
    instanceStarted(id) {
      const safe = safeUsageId(id)
      if (instanceId === safe && open.has("instance")) return
      if (open.has("instance")) end("instance")
      instanceId = safe
      begin("instance", { scope: "instance" })
    },
    instanceStopped() {
      end("instance")
    },
    sessionStarted(sessionId, deviceFingerprint) {
      const safe = safeUsageId(sessionId)
      begin(`session:${safe}`, {
        scope: "session",
        sessionId: safe,
        ...(deviceFingerprint !== undefined ? { deviceFingerprint } : {}),
      })
    },
    sessionStopped(sessionId) {
      end(`session:${safeUsageId(sessionId)}`)
    },
    stopAll() {
      closeSessions()
      end("instance")
    },
  }
  return tracker
}

export interface JsonlUsageMeterOptions {
  path: string
}

/** Append-only JSONL sink, file 0600 and directory 0700. Errors propagate to the tracker, which swallows them. */
export function createJsonlUsageMeter(opts: JsonlUsageMeterOptions): UsageMeter {
  const write = (row: object): void => {
    mkdirSync(dirname(opts.path), { recursive: true, mode: 0o700 })
    appendFileSync(opts.path, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    if (process.platform !== "win32" && (statSync(opts.path).mode & 0o077) !== 0) chmodSync(opts.path, 0o600)
  }
  return {
    record(event: UsageEvent) {
      write({ kind: "tool", tool: event.tool, ...(event.plugin ? { plugin: event.plugin } : {}), ok: event.ok, ms: event.ms })
    },
    browser(event: BrowserUsageEvent) {
      write(event)
    },
  }
}
