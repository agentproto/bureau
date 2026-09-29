/**
 * Camofox backend health — feature-detected `/health` shape + the two
 * reliability primitives the active driver pool needs (observed in a live run):
 *
 *   1. `isRecoverableBackendError` — classifies an error from a camofox REST
 *      call (tab op, navigate, tab create) as "the backend instance is gone or
 *      was mid-restart", so the caller knows to evict its cached driver and
 *      retry rather than surface a permanent failure. Covers BOTH the
 *      not-found/closed family (item 1: stale pooled tab after a restart) and
 *      the launch-coincident-timeout family (items 2+3: cold relaunch takes
 *      longer than the per-call budget, so a call racing it times out even
 *      though the browser finishes launching moments later).
 *
 *   2. `withLaunchRetry` — retries an operation that fails with a
 *      launch-coincident error, bounded by a total elapsed budget
 *      ({@link LAUNCH_BUDGET_MS} by default) instead of failing once. A
 *      slow-but-progressing launch (machine under load, INPUTS item 3) is not
 *      a failure; only exhausting the whole budget is.
 *
 * `bootId` / `browserState` are NOT in today's live `/health` — they're a
 * forward-compat field a later camofox-server lane (L3c) adds. Every read
 * here treats them as optional so this module works unchanged before and
 * after that field lands (the "feature-detect" contract PLAN-FINAL.md
 * describes for L0 vs. L3c).
 */

import { LAUNCH_BUDGET_MS } from "./ensure-camofox.js"

export { LAUNCH_BUDGET_MS }

/** The live `/health` shape, plus the optional L3c fields feature-detected
 *  here (present → used; absent → every check below degrades gracefully). */
export interface CamofoxHealthSnapshot {
  ok: boolean
  engine?: string
  browserConnected?: boolean
  browserRunning?: boolean
  activeTabs?: number
  activeSessions?: number
  consecutiveFailures?: number
  recovering?: boolean
  /** Forward-compat (L3c): random per-process id, changes across a backend restart. */
  bootId?: string
  /** Forward-compat (L3c). */
  browserState?: "launching" | "running" | "idle" | "crash-looping"
  /** Forward-compat (L3c). */
  launchedAt?: string
}

/** Fetch camofox `/health`. Never throws — an unreachable backend reads as
 *  `{ ok: false }` so callers can treat "unknown" the same as "not ready". */
export async function fetchCamofoxHealth(
  base: string,
  fetchImpl: typeof fetch = fetch
): Promise<CamofoxHealthSnapshot> {
  try {
    const res = await fetchImpl(`${base.replace(/\/$/, "")}/health`)
    const body = (await res.json().catch(() => ({}))) as Partial<CamofoxHealthSnapshot>
    return { ok: res.ok, ...body }
  } catch {
    return { ok: false }
  }
}

/**
 * Error signatures observed live (recorded from a cold-start repro) that mean "the backend instance is gone, mid-restart, or
 * the operation raced a launch" — the pooled driver/tab should be evicted and
 * the caller may retry, rather than treat this as a normal, permanent tool
 * error (a bad selector, a real network failure on the target site, ...).
 */
const RECOVERABLE_BACKEND_ERROR_RE =
  /ECONNREFUSED|socket hang up|ECONNRESET|disconnected|tab not found|no such tab|no tab found|timed out|timeout|newcontext_timeout|context or browser has been closed|browser has been closed/i

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isRecoverableBackendError(err: unknown): boolean {
  return RECOVERABLE_BACKEND_ERROR_RE.test(errorMessage(err))
}

/** Thrown when {@link withLaunchRetry} exhausts its budget — a typed "the
 *  browser never finished starting" state (INPUTS item 2's "surface a typed
 *  browser starting state"), distinguishable from a plain camofox error. */
export class BrowserStartingTimeoutError extends Error {
  constructor(
    message: string,
    readonly cause: unknown
  ) {
    super(message)
    this.name = "BrowserStartingTimeoutError"
  }
}

/**
 * Retry `attempt()` while it keeps failing with a launch-coincident /
 * recoverable error, bounded by `budgetMs` total elapsed wall time — not a
 * fixed retry count, since a real cold launch (47-80s observed) can take
 * several of the backend's own ~30s per-call budgets. Any OTHER error (a bad
 * selector, a real 4xx) is rethrown immediately, unretried.
 */
export async function withLaunchRetry<T>(opts: {
  attempt: () => Promise<T>
  isRecoverable?: (err: unknown) => boolean
  budgetMs?: number
  retryDelayMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (s: string) => void
  label?: string
}): Promise<T> {
  const isRecoverable = opts.isRecoverable ?? isRecoverableBackendError
  const budgetMs = opts.budgetMs ?? LAUNCH_BUDGET_MS
  const retryDelayMs = opts.retryDelayMs ?? 1000
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const log = opts.log ?? (() => {})
  const label = opts.label ?? "operation"
  const start = now()

  for (;;) {
    try {
      return await opts.attempt()
    } catch (err) {
      if (!isRecoverable(err)) throw err
      const elapsed = now() - start
      if (elapsed >= budgetMs) {
        throw new BrowserStartingTimeoutError(
          `${label}: still failing after ${elapsed}ms (budget ${budgetMs}ms) — ` +
            `last error: ${errorMessage(err)}`,
          err
        )
      }
      log(
        `[bureau] ${label}: recoverable backend error (${errorMessage(err)}), ` +
          `retrying (elapsed ${elapsed}ms of ${budgetMs}ms budget)`
      )
      await sleep(retryDelayMs)
    }
  }
}

/**
 * Tracks the camofox backend's identity across `/health` observations via the
 * forward-compat `bootId` field (L3c). Feature-detected: while `bootId` is
 * absent (today's live camofox), {@link observe} always returns `false` — no
 * behaviour change until L3c ships the field. Once present, a change in
 * `bootId` between two observations means the backend process restarted, so
 * every pooled driver is stale even before any of them fail an operation.
 */
export function createBackendInstanceTracker(log: (s: string) => void = () => {}): {
  /** Returns true iff `health.bootId` differs from the last-seen bootId (a
   *  real restart, not the first observation). */
  observe(health: CamofoxHealthSnapshot): boolean
} {
  let lastBootId: string | undefined
  let seen = false
  return {
    observe(health) {
      if (!health.bootId) return false
      if (!seen) {
        lastBootId = health.bootId
        seen = true
        return false
      }
      if (health.bootId !== lastBootId) {
        log(`[bureau] backend instance changed (bootId ${lastBootId} -> ${health.bootId})`)
        lastBootId = health.bootId
        return true
      }
      return false
    },
  }
}
