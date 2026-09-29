import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserUsageEvent, UsageEvent, UsageMeter } from "../plugin.js"
import { createBrowserUsageTracker, createJsonlUsageMeter, noopUsageTracker, safeUsageId, type UsageClock } from "./usage-meter.js"

interface FakeClock extends UsageClock {
  t: number
  tick(ms: number): void
  active(): number
}

function fakeClock(): FakeClock {
  const timers = new Map<number, { fn: () => void; every: number; next: number }>()
  let seq = 0
  const clock: FakeClock = {
    t: Date.parse("2026-09-29T10:00:00.000Z"),
    now: () => clock.t,
    setInterval(fn, ms) {
      seq += 1
      timers.set(seq, { fn, every: ms, next: clock.t + ms })
      return seq
    },
    clearInterval(handle) {
      timers.delete(handle as number)
    },
    tick(ms) {
      const end = clock.t + ms
      for (;;) {
        const due = [...timers.values()].filter(x => x.next <= end).sort((a, b) => a.next - b.next)[0]
        if (!due) break
        clock.t = due.next
        due.next += due.every
        due.fn()
      }
      clock.t = end
    },
    active: () => timers.size,
  }
  return clock
}

const collect = (): { meter: UsageMeter; events: BrowserUsageEvent[] } => {
  const events: BrowserUsageEvent[] = []
  return { events, meter: { record: () => {}, browser: e => void events.push(e) } }
}
const shape = (events: BrowserUsageEvent[]): string[] => events.map(e => `${e.type}:${e.scope}${e.sessionId ? `:${e.sessionId}` : ""}:${e.durationMs}`)

describe("browser usage tracker", () => {
  it("emits start, heartbeat and stop in order with an injected clock", () => {
    const clock = fakeClock()
    const { meter, events } = collect()
    const tracker = createBrowserUsageTracker({ meter, browser: "camofox", clock, heartbeatMs: 1000 })
    tracker.instanceStarted("inst-1")
    clock.tick(2500)
    tracker.instanceStopped()
    expect(shape(events)).toEqual(["start:instance:0", "heartbeat:instance:1000", "heartbeat:instance:2000", "stop:instance:2500"])
    expect(events.every(e => e.browser === "camofox" && e.instanceId === "inst-1")).toBe(true)
    expect(clock.active()).toBe(0)
  })

  it("meters each session on its own span and carries the device fingerprint", () => {
    const clock = fakeClock()
    const { meter, events } = collect()
    const tracker = createBrowserUsageTracker({ meter, browser: "camofox", clock, heartbeatMs: 1000 })
    tracker.instanceStarted("inst-1")
    clock.tick(500)
    tracker.sessionStarted("s1", "fp-a")
    clock.tick(1000)
    tracker.sessionStopped("s1")
    tracker.instanceStopped()
    expect(shape(events)).toEqual([
      "start:instance:0",
      "start:session:s1:0",
      "heartbeat:instance:1000",
      "heartbeat:session:s1:500",
      "stop:session:s1:1000",
      "stop:instance:1500",
    ])
    expect(events.find(e => e.scope === "session")?.deviceFingerprint).toBe("fp-a")
    expect(events.find(e => e.scope === "instance")?.deviceFingerprint).toBeUndefined()
  })

  it("is idempotent, restarts a span on a new instance id, and stopAll closes everything", () => {
    const clock = fakeClock()
    const { meter, events } = collect()
    const tracker = createBrowserUsageTracker({ meter, browser: "b", clock, heartbeatMs: 1000 })
    tracker.instanceStarted("i1")
    tracker.instanceStarted("i1")
    tracker.sessionStarted("s1")
    tracker.sessionStarted("s1")
    clock.tick(100)
    tracker.instanceStarted("i2")
    tracker.stopAll()
    expect(shape(events).filter(s => s.startsWith("start")).length).toBe(3)
    expect(shape(events).filter(s => s.startsWith("stop")).length).toBe(3)
    expect(clock.active()).toBe(0)
    tracker.instanceStopped()
    tracker.sessionStopped("never-started")
    expect(events.length).toBe(6)
  })

  it("survives a meter that throws or rejects", async () => {
    const clock = fakeClock()
    const tracker = createBrowserUsageTracker({
      meter: {
        record: () => {},
        browser: () => {
          throw new Error("meter down")
        },
      },
      browser: "b",
      clock,
    })
    expect(() => {
      tracker.instanceStarted("i")
      tracker.instanceStopped()
    }).not.toThrow()
    const rejecting = createBrowserUsageTracker({ meter: { record: () => {}, browser: () => Promise.reject(new Error("no")) }, browser: "b", clock })
    rejecting.instanceStarted("i")
    rejecting.stopAll()
    await new Promise(r => setTimeout(r, 5))
  })

  it("replaces an unsafe id (a URL) with a short hash", () => {
    expect(safeUsageId("session-1")).toBe("session-1")
    const hashed = safeUsageId("https://example.com/a?token=secret")
    expect(hashed).toMatch(/^h_[0-9a-f]{16}$/)
    const clock = fakeClock()
    const { meter, events } = collect()
    createBrowserUsageTracker({ meter, browser: "b", clock }).sessionStarted("https://example.com/a?token=secret")
    expect(JSON.stringify(events)).not.toContain("secret")
  })

  it("the noop tracker and a meter without a browser hook emit nothing", () => {
    const clock = fakeClock()
    noopUsageTracker.instanceStarted("i")
    noopUsageTracker.sessionStarted("s", "fp")
    noopUsageTracker.stopAll()
    const tools: UsageEvent[] = []
    const toolOnly: UsageMeter = { record: e => void tools.push(e) }
    const tracker = createBrowserUsageTracker({ meter: toolOnly, browser: "b", clock, heartbeatMs: 10 })
    tracker.instanceStarted("i")
    clock.tick(100)
    tracker.stopAll()
    expect(tools).toEqual([])
  })
})

describe("JSONL usage meter", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bureau-usage-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("writes a 0600 file with only ids, the browser, durations and the fingerprint", () => {
    const path = join(dir, "nested", "usage.jsonl")
    const clock = fakeClock()
    const tracker = createBrowserUsageTracker({ meter: createJsonlUsageMeter({ path }), browser: "camofox", clock, heartbeatMs: 1000 })
    tracker.instanceStarted("inst-1")
    tracker.sessionStarted("s1", "fp-a")
    clock.tick(1500)
    tracker.stopAll()
    expect(existsSync(path)).toBe(true)
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700)
    }
    const rows = readFileSync(path, "utf8").trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>)
    expect(rows.map(r => `${String(r.type)}:${String(r.scope)}`)).toEqual([
      "start:instance",
      "start:session",
      "heartbeat:instance",
      "heartbeat:session",
      "stop:session",
      "stop:instance",
    ])
    const allowed = new Set(["kind", "type", "scope", "browser", "instanceId", "sessionId", "deviceFingerprint", "at", "durationMs"])
    for (const r of rows) for (const k of Object.keys(r)) expect(allowed.has(k), k).toBe(true)
  })

  it("tightens a file that was created wider", () => {
    const path = join(dir, "usage.jsonl")
    const meter = createJsonlUsageMeter({ path })
    meter.record({ tool: "browser_navigate", ok: true, ms: 5 })
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, "utf8").trim())).toEqual({ kind: "tool", tool: "browser_navigate", ok: true, ms: 5 })
  })
})
