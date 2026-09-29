import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { createCamofoxHarness, type CamofoxHarness } from "../__tests__/support/browser-fakes.js"
import { bootServe, registryOver, tempHome, type Booted, type TempHome } from "../__tests__/support/serve-harness.js"
import { readRunState, runStatePath, writeRunState, type RunState } from "../lib/run-state.js"
import { runStop } from "./stop.js"

let tmp: TempHome
beforeEach(() => {
  tmp = tempHome("bureau-stop-")
})
afterEach(() => tmp.cleanup())

const state = (over: Partial<RunState> = {}): RunState => ({
  version: 1,
  pid: 424242,
  port: 18830,
  host: "127.0.0.1",
  browser: "camofox",
  browserOwned: true,
  startedAt: "2026-09-29T00:00:00.000Z",
  ...over,
})

const okFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch
const deadFetch = (async () => {
  throw new Error("ECONNREFUSED")
}) as typeof fetch

function run(deps: Parameters<typeof runStop>[1] = {}, argv: string[] = []): Promise<{ code: number; lines: string[]; killed: Array<[number, string]> }> {
  const lines: string[] = []
  const killed: Array<[number, string]> = []
  return runStop(argv, {
    home: tmp.home,
    sleep: async () => {},
    log: l => void lines.push(l),
    kill: (pid, sig) => void killed.push([pid, sig]),
    ...deps,
  }).then(code => ({ code, lines, killed }))
}

describe("bureau stop", () => {
  it("does nothing when bureau start never ran", async () => {
    const r = await run()
    expect(r.code).toBe(0)
    expect(r.killed).toHaveLength(0)
    expect(r.lines.join("\n")).toContain("nothing started by bureau")
  })

  it("removes a stale state file without signalling anything", async () => {
    await writeRunState(tmp.home, state())
    const r = await run({ isAlive: () => false, fetch: okFetch })
    expect(r.code).toBe(0)
    expect(r.killed).toHaveLength(0)
    expect(existsSync(runStatePath(tmp.home))).toBe(false)
  })

  it("refuses to signal a live pid that does not answer /health (recycled pid)", async () => {
    await writeRunState(tmp.home, state())
    const r = await run({ isAlive: () => true, fetch: deadFetch })
    expect(r.code).toBe(1)
    expect(r.killed).toHaveLength(0)
    expect(existsSync(runStatePath(tmp.home))).toBe(true)
  })

  it("stops an owned browser's Bureau and says the browser was stopped", async () => {
    await writeRunState(tmp.home, state({ browserOwned: true }))
    let alive = true
    const r = await run({ isAlive: () => alive, fetch: okFetch, kill: (pid, sig) => { alive = false; void [pid, sig] } })
    expect(r.code).toBe(0)
    expect(r.lines.join("\n")).toContain("was started by bureau and has been stopped")
    expect(existsSync(runStatePath(tmp.home))).toBe(false)
  })

  it("leaves a browser that was already running and says so", async () => {
    await writeRunState(tmp.home, state({ browserOwned: false }))
    let alive = true
    const r = await run({ isAlive: () => alive, fetch: okFetch, kill: () => { alive = false } })
    expect(r.code).toBe(0)
    expect(r.lines.join("\n")).toContain("already running when bureau started, so it was left running")
  })

  it("fails when the process does not exit in time", async () => {
    await writeRunState(tmp.home, state())
    const r = await run({ isAlive: () => true, fetch: okFetch }, ["--timeout", "0.05"])
    expect(r.code).toBe(1)
    expect(r.killed).toEqual([[424242, "SIGTERM"]])
    expect(r.lines.join("\n")).toContain("did not exit")
  })

  it("prints usage without em dashes", async () => {
    const r = await run({}, ["--help"])
    expect(r.lines.join("\n")).not.toContain("—")
  })
})

describe("bureau stop against a real serve (fake camofox)", () => {
  let camofox: CamofoxHarness | undefined
  let booted: Booted | undefined
  afterEach(async () => {
    await booted?.handle.close().catch(() => {})
    await camofox?.dispose()
    booted = camofox = undefined
  })

  it("stops only what bureau started: the owned browser goes, the state file goes", async () => {
    camofox = await createCamofoxHarness("down")
    booted = await bootServe({ argv: ["--camofox-cmd", "fake-camofox serve"], registry: registryOver(camofox.provider), home: tmp.home })
    await booted.handle.browserReady
    const before = await readRunState(tmp.home)
    expect(before?.browserOwned).toBe(true)
    const pid = before?.browserPid ?? 0
    let closed = false
    const lines: string[] = []
    const code = await runStop([], {
      home: tmp.home,
      isAlive: () => !closed,
      kill: () => void (booted!.handle.close().then(() => (closed = true))),
      sleep: () => new Promise(r => setTimeout(r, 10)),
      log: l => void lines.push(l),
    })
    expect(code).toBe(0)
    expect(lines.join("\n")).toContain("was started by bureau and has been stopped")
    expect(existsSync(runStatePath(tmp.home))).toBe(false)
    const end = Date.now() + 3000
    const alive = (): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
    while (alive() && Date.now() < end) await new Promise(r => setTimeout(r, 10))
    expect(alive()).toBe(false)
  })

  it("leaves a camofox it merely found running", async () => {
    camofox = await createCamofoxHarness("ok")
    booted = await bootServe({ argv: ["--camofox-cmd", "fake-camofox serve"], registry: registryOver(camofox.provider), home: tmp.home })
    await booted.handle.browserReady
    let closed = false
    const lines: string[] = []
    const code = await runStop([], {
      home: tmp.home,
      isAlive: () => !closed,
      kill: () => void (booted!.handle.close().then(() => (closed = true))),
      sleep: () => new Promise(r => setTimeout(r, 10)),
      log: l => void lines.push(l),
    })
    expect(code).toBe(0)
    expect(lines.join("\n")).toContain("left running")
    expect(camofox.fake.listening).toBe(true)
  })
})
