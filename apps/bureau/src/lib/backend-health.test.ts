import { describe, expect, it, vi } from "vitest"
import {
  BrowserStartingTimeoutError,
  createBackendInstanceTracker,
  fetchCamofoxHealth,
  isRecoverableBackendError,
  withLaunchRetry,
} from "./backend-health.js"

describe("isRecoverableBackendError", () => {
  it("matches the tab-not-found family (item 1: stale pooled tab after restart)", () => {
    expect(isRecoverableBackendError(new Error("Tab not found"))).toBe(true)
    expect(
      isRecoverableBackendError(new Error("POST /tabs/x/navigate → 404: Tab not found"))
    ).toBe(true)
  })

  it("matches the launch-coincident timeout family (items 2+3, observed live)", () => {
    expect(
      isRecoverableBackendError(new Error('POST /tabs → 500: {"error":"tab create timed out after 30000ms"}'))
    ).toBe(true)
    expect(isRecoverableBackendError(new Error("newcontext_timeout"))).toBe(true)
    expect(
      isRecoverableBackendError(
        new Error("browser.newContext: Target page, context or browser has been closed")
      )
    ).toBe(true)
  })

  it("does not match a normal tool error", () => {
    expect(isRecoverableBackendError(new Error("selector not found: .foo"))).toBe(false)
    expect(isRecoverableBackendError(new Error("HTTP 401 unauthorized"))).toBe(false)
  })
})

describe("fetchCamofoxHealth", () => {
  it("returns ok:false without throwing when the backend is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    const health = await fetchCamofoxHealth("http://127.0.0.1:9377", fetchImpl)
    expect(health).toEqual({ ok: false })
  })

  it("feature-detects bootId/browserState as optional, absent today", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, browserRunning: true }),
    })
    const health = await fetchCamofoxHealth("http://127.0.0.1:9377", fetchImpl)
    expect(health.browserRunning).toBe(true)
    expect(health.bootId).toBeUndefined()
  })
})

describe("withLaunchRetry", () => {
  it("retries a launch-coincident timeout across a 70s cold launch (fake clock), then succeeds", async () => {
    let now = 0
    let attempts = 0
    const launchDoneAtMs = 70_000

    const result = await withLaunchRetry({
      attempt: async () => {
        attempts++
        if (now < launchDoneAtMs) {
          throw new Error("tab create timed out after 30000ms")
        }
        return "ok"
      },
      now: () => now,
      sleep: async ms => {
        now += ms
      },
      retryDelayMs: 5000,
      budgetMs: 120_000,
    })

    expect(result).toBe("ok")
    expect(attempts).toBeGreaterThan(1)
  })

  it("does not treat a slow-but-progressing launch (>=30s) as a restart loop", async () => {
    let now = 0
    let attempts = 0
    const readyAtMs = 35_000 // over a single 30s per-call budget, under the 120s budget

    const result = await withLaunchRetry({
      attempt: async () => {
        attempts++
        if (now < readyAtMs) throw new Error("newcontext_timeout")
        return "ready"
      },
      now: () => now,
      sleep: async ms => {
        now += ms
      },
      retryDelayMs: 2000,
      budgetMs: 120_000,
    })

    expect(result).toBe("ready")
    expect(attempts).toBeGreaterThan(1)
  })

  it("throws a typed BrowserStartingTimeoutError once the budget is exhausted", async () => {
    let now = 0
    await expect(
      withLaunchRetry({
        attempt: async () => {
          throw new Error("tab create timed out after 30000ms")
        },
        now: () => now,
        sleep: async ms => {
          now += ms
        },
        retryDelayMs: 10_000,
        budgetMs: 30_000,
      })
    ).rejects.toBeInstanceOf(BrowserStartingTimeoutError)
  })

  it("rethrows a non-recoverable error immediately, unretried", async () => {
    let attempts = 0
    await expect(
      withLaunchRetry({
        attempt: async () => {
          attempts++
          throw new Error("selector not found: .foo")
        },
        budgetMs: 120_000,
      })
    ).rejects.toThrow(/selector not found/)
    expect(attempts).toBe(1)
  })
})

describe("createBackendInstanceTracker", () => {
  it("is a no-op while bootId is absent (feature-detected, today's live camofox)", () => {
    const tracker = createBackendInstanceTracker()
    expect(tracker.observe({ ok: true })).toBe(false)
    expect(tracker.observe({ ok: true })).toBe(false)
  })

  it("reports a change on the second observation with a different bootId", () => {
    const log = vi.fn()
    const tracker = createBackendInstanceTracker(log)
    expect(tracker.observe({ ok: true, bootId: "boot-1" })).toBe(false)
    expect(tracker.observe({ ok: true, bootId: "boot-1" })).toBe(false)
    expect(tracker.observe({ ok: true, bootId: "boot-2" })).toBe(true)
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boot-1 -> boot-2"))
  })
})
