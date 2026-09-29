import { describe, expect, it, vi } from "vitest"
import type { HumanSession, SessionResolver } from "./ports.js"
import {
  createActEntry,
  createActiveDriverPool,
  createSessionAwareControlEntries,
} from "./active-driver-pool.js"
import type { McpEntry } from "../mcp-tool.js"

/** A minimal HumanSession double — only the verbs the tests below touch. */
function fakeHumanSession(overrides: Partial<HumanSession> = {}): HumanSession {
  return {
    navigate: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    gotoPaced: vi.fn().mockResolvedValue(undefined),
    scroll: vi.fn().mockResolvedValue(undefined),
    acceptConsent: vi.fn().mockResolvedValue(false),
    type: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    isBlocked: vi.fn().mockResolvedValue(false),
    readNextData: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

/** The raw (unscoped) control catalogue entry stub `browser_screenshot`
 *  normally resolves to — a session-scoped call must never reach this. */
function rawScreenshotEntry(): { entry: McpEntry; calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    entry: {
      name: "browser_screenshot",
      description: "raw",
      jsonSchema: { type: "object", properties: {} },
      call: async () => {
        calls += 1
        return { content: [{ type: "text", text: "{}" }] }
      },
    },
  }
}

describe("createSessionAwareControlEntries — browser_screenshot", () => {
  it("routes a session-scoped call through the pooled driver, not the raw control tab", async () => {
    const shotBytes = Buffer.from("fake-png-bytes").toString("base64")
    const human = fakeHumanSession({
      screenshot: vi
        .fn()
        .mockResolvedValue({ imageBase64: shotBytes, mimeType: "image/png" }),
    })
    const base: SessionResolver = { resolve: vi.fn().mockResolvedValue(human) }
    const { resolvePooledDriver, pool } = createActiveDriverPool(base)

    const raw = rawScreenshotEntry()
    const [wrapped] = createSessionAwareControlEntries(
      [raw.entry],
      resolvePooledDriver,
      pool
    )

    const result = await wrapped!.call({ session: "ovh" })
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      base64: string
      format: string
      session: string
    }

    expect(parsed.base64).toBe(shotBytes)
    expect(parsed.format).toBe("png")
    expect(parsed.session).toBe("ovh")
    expect(human.screenshot).toHaveBeenCalledTimes(1)
    expect(base.resolve).toHaveBeenCalledWith("ovh")
    expect(raw.calls()).toBe(0)
  })

  it("reuses the SAME pooled tab a prior session-scoped navigate landed on", async () => {
    const human = fakeHumanSession({
      screenshot: vi.fn().mockResolvedValue({
        imageBase64: "abc",
        mimeType: "image/png",
      }),
    })
    const resolve = vi.fn().mockResolvedValue(human)
    const base: SessionResolver = { resolve }
    const { resolvePooledDriver, pool } = createActiveDriverPool(base)

    const rawNavigate: McpEntry = {
      name: "browser_navigate",
      description: "raw",
      jsonSchema: { type: "object", properties: {} },
      call: async () => ({ content: [{ type: "text", text: "{}" }] }),
    }
    const [navEntry, shotEntry] = createSessionAwareControlEntries(
      [rawNavigate, rawScreenshotEntry().entry],
      resolvePooledDriver,
      pool
    )

    await navEntry!.call({ session: "ovh", url: "https://example.com" })
    await shotEntry!.call({ session: "ovh" })

    // resolve() (the expensive open/cookie-inject) happened exactly once —
    // the second call reused the pooled promise instead of re-resolving.
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(human.navigate).toHaveBeenCalledWith("https://example.com")
    expect(human.screenshot).toHaveBeenCalledTimes(1)
  })

  it("falls through to the raw (anonymous-tab) entry when no session is given", async () => {
    const base: SessionResolver = { resolve: vi.fn() }
    const { resolvePooledDriver, pool } = createActiveDriverPool(base)
    const raw = rawScreenshotEntry()
    const [wrapped] = createSessionAwareControlEntries(
      [raw.entry],
      resolvePooledDriver,
      pool
    )

    await wrapped!.call({})
    expect(base.resolve).not.toHaveBeenCalled()
  })

  it("errors clearly when the session's HumanSession has no raster capability", async () => {
    const human = fakeHumanSession() // no `screenshot` override
    const base: SessionResolver = { resolve: vi.fn().mockResolvedValue(human) }
    const { resolvePooledDriver, pool } = createActiveDriverPool(base)
    const raw = rawScreenshotEntry()
    const [wrapped] = createSessionAwareControlEntries(
      [raw.entry],
      resolvePooledDriver,
      pool
    )

    await expect(wrapped!.call({ session: "ovh" })).rejects.toThrow(
      /no raster capability/
    )
  })
})

describe("browser_navigate — idempotent per session (INPUTS item 4)", () => {
  it("a caller retry with the same session reuses the same tab instead of opening a second one", async () => {
    const human = fakeHumanSession({ navigate: vi.fn().mockResolvedValue(undefined) })
    const resolve = vi.fn().mockResolvedValue(human)
    const base: SessionResolver = { resolve }
    const { resolvePooledDriver, pool } = createActiveDriverPool(base)

    const rawNavigate: McpEntry = {
      name: "browser_navigate",
      description: "raw",
      jsonSchema: { type: "object", properties: {} },
      call: async () => ({ content: [{ type: "text", text: "{}" }] }),
    }
    const [navEntry] = createSessionAwareControlEntries(
      [rawNavigate],
      resolvePooledDriver,
      pool
    )

    // A caller retry (e.g. after a slow response it gave up waiting on) with
    // the SAME session and SAME url must not fan out into a second tab —
    // `base.resolve` (the expensive open/cookie-inject) runs exactly once.
    await navEntry!.call({ session: "ovh", url: "https://example.com/a" })
    await navEntry!.call({ session: "ovh", url: "https://example.com/a" })
    // A subsequent navigate to a DIFFERENT url on the same session still
    // reuses the one pooled tab, not a fresh one.
    await navEntry!.call({ session: "ovh", url: "https://example.com/b" })

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(human.navigate).toHaveBeenCalledTimes(3)
    expect(human.navigate).toHaveBeenNthCalledWith(1, "https://example.com/a")
    expect(human.navigate).toHaveBeenNthCalledWith(3, "https://example.com/b")
  })
})

// Live-run reliability: backend restart, cold launch and slow machine.

describe("L0 reliability — backend restart, cold launch, slow machine", () => {
  it("item 1: a fake camofox that 'restarts' (tab ids reset) — the next session call succeeds without restarting Bureau", async () => {
    // Simulate: generation 1's HumanSession is cached by the pool. The
    // backend then "restarts" — its tab ids reset, so the very next operation
    // against the STALE HumanSession fails with the real error shape camofox
    // returns for an unknown tabId ("Tab not found", capitalised, from a JSON
    // body — see server.js's `res.status(404).json({ error: 'Tab not found' })`).
    // base.resolve (the expensive re-adopt) must be called again to produce a
    // fresh, generation-2 HumanSession bound to the new tab.
    let generation = 1
    const human1 = fakeHumanSession({
      // Succeeds the first time (the pre-restart call); the backend "restart"
      // then leaves this cached driver's tab gone, so its SECOND invocation
      // hits the stale-tab error.
      navigate: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new Error("Tab not found")),
    })
    const human2 = fakeHumanSession({ navigate: vi.fn().mockResolvedValue(undefined) })
    const resolve = vi.fn().mockImplementation(async () => {
      return generation === 1 ? human1 : human2
    })
    const base: SessionResolver = { resolve }
    const { resolvePooledDriver, pool } = createActiveDriverPool(base)

    const rawNavigate: McpEntry = {
      name: "browser_navigate",
      description: "raw",
      jsonSchema: { type: "object", properties: {} },
      call: async () => ({ content: [{ type: "text", text: "{}" }] }),
    }
    const [navEntry] = createSessionAwareControlEntries(
      [rawNavigate],
      resolvePooledDriver,
      pool
    )

    // First call resolves + caches generation-1's (about-to-be-stale) driver.
    await navEntry!.call({ session: "ovh", url: "https://example.com" })
    expect(resolve).toHaveBeenCalledTimes(1)

    // "Restart" the fake backend, then drive the SAME session again — the
    // cached driver's navigate fails with the reset-tab error; the pool must
    // self-heal (evict + re-resolve + retry) WITHOUT any caller-visible
    // failure and WITHOUT Bureau itself restarting (the pool is never torn
    // down here — same `pool`/`resolvePooledDriver` instance throughout).
    generation = 2
    const result = await navEntry!.call({ session: "ovh", url: "https://example.com" })

    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      url: "https://example.com",
      session: "ovh",
    })
    expect(resolve).toHaveBeenCalledTimes(2) // evicted + re-resolved once
    expect(human2.navigate).toHaveBeenCalledWith("https://example.com")
    expect(pool.has("ovh")).toBe(true) // the healed driver is cached again
  })

  it("item 2: a fake backend taking 70s to launch (fake clock) — the first navigate succeeds", async () => {
    let virtualNow = 0
    const human = fakeHumanSession({ navigate: vi.fn().mockResolvedValue(undefined) })
    let attempts = 0
    const launchDoneAtMs = 70_000
    const resolve = vi.fn().mockImplementation(async () => {
      attempts++
      if (virtualNow < launchDoneAtMs) {
        throw new Error("tab create timed out after 30000ms")
      }
      return human
    })
    const base: SessionResolver = { resolve }
    const { resolvePooledDriver } = createActiveDriverPool(base, {
      now: () => virtualNow,
      sleep: async ms => {
        virtualNow += ms
      },
      retryDelayMs: 5_000,
      launchBudgetMs: 120_000,
    })

    const rawNavigate: McpEntry = {
      name: "browser_navigate",
      description: "raw",
      jsonSchema: { type: "object", properties: {} },
      call: async () => ({ content: [{ type: "text", text: "{}" }] }),
    }
    const [navEntry] = createSessionAwareControlEntries(
      [rawNavigate],
      resolvePooledDriver,
      new Map()
    )

    const result = await navEntry!.call({ session: "ovh", url: "https://example.com" })

    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      url: "https://example.com",
    })
    expect(attempts).toBeGreaterThan(1)
    expect(virtualNow).toBeGreaterThanOrEqual(launchDoneAtMs)
  })

  it("item 3: a slow-but-progressing fake (context creation >= 30s fake time) does not trigger a restart loop", async () => {
    let virtualNow = 0
    const human = fakeHumanSession()
    let attempts = 0
    const readyAtMs = 35_000
    const resolve = vi.fn().mockImplementation(async () => {
      attempts++
      if (virtualNow < readyAtMs) throw new Error("newcontext_timeout")
      return human
    })
    const base: SessionResolver = { resolve }
    const { resolvePooledDriver } = createActiveDriverPool(base, {
      now: () => virtualNow,
      sleep: async ms => {
        virtualNow += ms
      },
      retryDelayMs: 2_000,
      launchBudgetMs: 120_000,
    })

    const result = await resolvePooledDriver("ovh")

    expect(result).toBe(human)
    // Progressing past a single ~30s attempt budget must NOT surface as a
    // permanent failure (no restart-loop-worthy error) as long as it lands
    // inside the overall launch budget.
    expect(attempts).toBeGreaterThan(1)
  })

  it("browser_act: read-only actions (goto/read) self-heal once on a recoverable error; mutating actions (click) do not auto-retry", async () => {
    let generation = 1
    const human1 = fakeHumanSession({
      navigate: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValue(new Error("Tab not found")),
      click: vi.fn().mockRejectedValue(new Error("Tab not found")),
    })
    const human2 = fakeHumanSession({
      navigate: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
    })
    const resolve = vi.fn().mockImplementation(async () => (generation === 1 ? human1 : human2))
    const base: SessionResolver = { resolve }
    const { resolvePooledDriver, pool } = createActiveDriverPool(base)
    const actEntry = createActEntry(resolvePooledDriver, pool)

    // goto (idempotent) — self-heals within this one call.
    await actEntry.call({ session: "ovh", action: "goto", url: "https://example.com" })
    generation = 2
    const gotoResult = await actEntry.call({
      session: "ovh",
      action: "goto",
      url: "https://example.com",
    })
    expect(
      JSON.parse((gotoResult.content[0] as { text: string }).text)
    ).toMatchObject({ ok: true })
    expect(resolve).toHaveBeenCalledTimes(2)

    // click (mutating) against the now-healthy pool still works normally...
    await actEntry.call({ session: "ovh", action: "click", selector: "#a" })
    expect(human2.click).toHaveBeenCalledWith("#a")

    // ...but if the pooled driver goes stale again, click surfaces the error
    // (no auto-retry against a freshly re-navigated, different-page tab) while
    // still evicting so the NEXT call self-heals.
    generation = 3
    const human3 = fakeHumanSession({ click: vi.fn().mockResolvedValue(undefined) })
    resolve.mockImplementation(async () => (generation === 2 ? human2 : human3))
    human2.click = vi.fn().mockRejectedValue(new Error("Tab not found"))
    await expect(
      actEntry.call({ session: "ovh", action: "click", selector: "#a" })
    ).rejects.toThrow(/Tab not found/)
    expect(pool.has("ovh")).toBe(false)

    const nextClick = await actEntry.call({
      session: "ovh",
      action: "click",
      selector: "#a",
    })
    expect(JSON.parse((nextClick.content[0] as { text: string }).text)).toMatchObject({
      ok: true,
    })
    expect(human3.click).toHaveBeenCalledWith("#a")
  })
})
