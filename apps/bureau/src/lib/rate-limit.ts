/**
 * Per-tool token-bucket rate limiter for the Bureau MCP dispatch.
 *
 * Zero-dependency, in-process (no Redis) — one bucket per tool NAME, refilled
 * lazily on `take()` rather than by a background timer, so an idle bucket
 * costs nothing and a burst after idle time gets its full capacity back.
 *
 * MUST be instantiated ONCE and shared across every dispatch — `lib/mcp-server.ts`
 * builds a fresh MCP `Server` + transport per HTTP request (see its file header),
 * but the limiter has to live in the OUTER create-once scope (same as `byName`)
 * or every request would get a fresh, full bucket and the limiter would be a
 * silent no-op.
 */

/** One tool's cadence: how many calls it can burst, and how fast it refills. */
export interface RateLimit {
  /** Max tokens the bucket holds — the burst ceiling. */
  capacity: number
  /** Tokens restored per second. */
  refillPerSec: number
}

/** Per-tool limits keyed by tool name, plus the mandatory fallback for any
 *  tool with no explicit entry. */
export interface RateLimitTable {
  DEFAULT: RateLimit
  [tool: string]: RateLimit
}

export interface RateLimiterOptions {
  /** Injectable clock — defaults to `Date.now`. Tests pass a fake one. */
  now?: () => number
  /** Kill-switch: when true, every `take()` short-circuits to `{ ok: true }`
   *  without touching any bucket. */
  disabled?: boolean
}

export type TakeResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number; limit: RateLimit }

export interface BucketStats {
  tokens: number
  capacity: number
  refillPerSec: number
}

export interface RateLimiter {
  /** Spend one token from `tool`'s bucket (refilling first). */
  take(tool: string): TakeResult
  /** Snapshot of every bucket that has been touched at least once — for
   *  observability (e.g. a debug/introspection endpoint), not enforcement. */
  stats(): Record<string, BucketStats>
}

interface Bucket {
  tokens: number
  lastRefill: number
}

/** Build a rate limiter over `limits` (must include `DEFAULT`). */
export function createRateLimiter(
  limits: RateLimitTable,
  opts: RateLimiterOptions = {}
): RateLimiter {
  const now = opts.now ?? Date.now
  const disabled = opts.disabled ?? false
  const buckets = new Map<string, Bucket>()

  const limitFor = (tool: string): RateLimit => limits[tool] ?? limits.DEFAULT

  const bucketFor = (tool: string, limit: RateLimit): Bucket => {
    const existing = buckets.get(tool)
    if (existing) return existing
    const fresh: Bucket = { tokens: limit.capacity, lastRefill: now() }
    buckets.set(tool, fresh)
    return fresh
  }

  return {
    take(tool) {
      if (disabled) return { ok: true }
      const limit = limitFor(tool)
      const bucket = bucketFor(tool, limit)

      const t = now()
      const elapsedSec = Math.max(0, (t - bucket.lastRefill) / 1000)
      if (elapsedSec > 0) {
        bucket.tokens = Math.min(
          limit.capacity,
          bucket.tokens + elapsedSec * limit.refillPerSec
        )
        bucket.lastRefill = t
      }

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1
        return { ok: true }
      }

      const deficit = 1 - bucket.tokens
      const retryAfterMs = Math.ceil((deficit / limit.refillPerSec) * 1000)
      return { ok: false, retryAfterMs, limit }
    },

    stats() {
      const out: Record<string, BucketStats> = {}
      for (const [tool, bucket] of buckets) {
        const limit = limitFor(tool)
        out[tool] = {
          tokens: Math.round(bucket.tokens * 100) / 100,
          capacity: limit.capacity,
          refillPerSec: limit.refillPerSec,
        }
      }
      return out
    },
  }
}

/**
 * Bureau's tool cadence table.
 *
 * DEFAULT is deliberately generous — cap 30 / refill 10 per second — so no
 * existing single-caller usage trips it (workflow runs, research jobs, and
 * introspection calls are all one-call-at-a-time or internally sequential;
 * see the recon note in the accompanying test file).
 *
 * The tight overrides below are anchored to two pieces of evidence found in
 * this codebase, not round guesses:
 *  - `packages/actions/src/tools/creator-discover.ts` paces its own external
 *    fetch loop at 1500ms/iteration (~0.67 req/s) — this repo's own definition
 *    of "polite" cadence for a host-heavy, per-item network operation.
 *  - `packages/actions/src/tools/inpi-auth.ts` documents live anti-bot
 *    throttling kicking in after "a ~15-login burst" — i.e. a real target
 *    starts pushing back around a burst of 15 in this codebase's experience.
 *
 * `browser_navigate` and `scrape` (both real, confirmed tool names — see the
 * step-1 recon note) get capacity 10 (safely under the observed ~15-burst
 * threshold) and refill 2/s (triple the codebase's own "polite" pace, so a
 * legitimate caller doing a few reads in a row never trips it, but a tight
 * spam loop does). `browser_act` gets the SAME treatment: its `goto` action
 * is functionally `browser_navigate` (drives `human.navigate(url)` — see
 * `lib/active-driver-pool.ts`), so gating navigate/scrape alone would leave an
 * open bypass via `browser_act`. `screen_capture` shells out to the macOS
 * `screencapture` binary plus disk I/O per call and has no legitimate
 * multi-per-second use case, so it gets the tightest budget: capacity 5,
 * refill 1/s.
 */
export const LIMITS: RateLimitTable = {
  DEFAULT: { capacity: 30, refillPerSec: 10 },
  browser_navigate: { capacity: 10, refillPerSec: 2 },
  scrape: { capacity: 10, refillPerSec: 2 },
  browser_act: { capacity: 10, refillPerSec: 2 },
  screen_capture: { capacity: 5, refillPerSec: 1 },
}
