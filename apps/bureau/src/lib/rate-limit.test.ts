import { describe, expect, it } from "vitest"
import { createRateLimiter, type RateLimitTable } from "./rate-limit.js"

/** A tiny fake clock — advance() moves time forward for the tests below. */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return { now: () => t, advance: ms => (t += ms) }
}

const limits: RateLimitTable = {
  DEFAULT: { capacity: 3, refillPerSec: 1 },
  screen_capture: { capacity: 2, refillPerSec: 1 },
  browser_navigate: { capacity: 2, refillPerSec: 1 },
}

describe("createRateLimiter", () => {
  it("passes the Nth call and trips the Nth+1 (capacity boundary)", () => {
    const clock = fakeClock()
    const limiter = createRateLimiter(limits, { now: clock.now })

    // capacity 3 for an unlisted tool (falls through to DEFAULT).
    expect(limiter.take("some_tool")).toEqual({ ok: true })
    expect(limiter.take("some_tool")).toEqual({ ok: true })
    expect(limiter.take("some_tool")).toEqual({ ok: true })

    const fourth = limiter.take("some_tool")
    expect(fourth.ok).toBe(false)
    if (!fourth.ok) {
      expect(fourth.retryAfterMs).toBeGreaterThan(0)
      expect(fourth.limit).toEqual(limits.DEFAULT)
    }
  })

  it("refills tokens after a time window", () => {
    const clock = fakeClock()
    const limiter = createRateLimiter(limits, { now: clock.now })

    expect(limiter.take("some_tool")).toEqual({ ok: true })
    expect(limiter.take("some_tool")).toEqual({ ok: true })
    expect(limiter.take("some_tool")).toEqual({ ok: true })
    expect(limiter.take("some_tool").ok).toBe(false)

    // DEFAULT refills 1 token/sec — after 1000ms exactly one more call fits.
    clock.advance(1000)
    expect(limiter.take("some_tool")).toEqual({ ok: true })
    expect(limiter.take("some_tool").ok).toBe(false)
  })

  it("keeps per-tool overrides independent — draining screen_capture doesn't drain browser_navigate", () => {
    const clock = fakeClock()
    const limiter = createRateLimiter(limits, { now: clock.now })

    // Drain screen_capture's bucket (capacity 2).
    expect(limiter.take("screen_capture")).toEqual({ ok: true })
    expect(limiter.take("screen_capture")).toEqual({ ok: true })
    expect(limiter.take("screen_capture").ok).toBe(false)

    // browser_navigate is untouched — still has its own full bucket.
    expect(limiter.take("browser_navigate")).toEqual({ ok: true })
    expect(limiter.take("browser_navigate")).toEqual({ ok: true })
    expect(limiter.take("browser_navigate").ok).toBe(false)
  })

  it("falls an unlisted tool through to DEFAULT", () => {
    const clock = fakeClock()
    const limiter = createRateLimiter(limits, { now: clock.now })

    expect(limiter.take("totally_unknown_tool")).toEqual({ ok: true })
    const stats = limiter.stats().totally_unknown_tool
    expect(stats.capacity).toBe(limits.DEFAULT.capacity)
    expect(stats.refillPerSec).toBe(limits.DEFAULT.refillPerSec)
  })

  it("bypasses throttling entirely when disabled", () => {
    const clock = fakeClock()
    const limiter = createRateLimiter(limits, { now: clock.now, disabled: true })

    for (let i = 0; i < 50; i++) {
      expect(limiter.take("screen_capture")).toEqual({ ok: true })
    }
    // A disabled limiter never touches a bucket — nothing to report.
    expect(limiter.stats()).toEqual({})
  })
})
