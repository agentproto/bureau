import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createFakeBrowserProvider } from "@agentproto/driver-browser"
import { createBureauBrowserRegistry } from "../lib/browser-registry.js"
import { runStatePath, writeRunState, type RunState } from "../lib/run-state.js"
import { runStart, type StartDeps } from "./start.js"
import { readFileSync } from "node:fs"
import { tempHome, type TempHome } from "../__tests__/support/serve-harness.js"
import { createChromeHarness } from "../__tests__/support/browser-fakes.js"
import type { BureauPlugin } from "../plugin.js"

let tmp: TempHome
beforeEach(() => {
  tmp = tempHome("bureau-start-")
})
afterEach(() => tmp.cleanup())

type Health = Record<string, unknown> | null

/** A fetch that answers /health from a script; the last entry repeats. */
function scriptedFetch(script: Health[]): typeof fetch {
  let i = 0
  return (async () => {
    const step = script[Math.min(i, script.length - 1)] ?? null
    i += 1
    if (step === null) throw new Error("connect ECONNREFUSED")
    return new Response(JSON.stringify(step), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
}

const healthy = (browser = "camofox", state = "healthy"): Record<string, unknown> => ({ ok: true, tools: 40, browser, state, restarts: 0, wasAlreadyRunning: false, since: "2026-09-29T00:00:00.000Z" })

const runState = (over: Partial<RunState> = {}): RunState => ({
  version: 1,
  pid: 424242,
  port: 18830,
  host: "127.0.0.1",
  browser: "camofox",
  browserOwned: true,
  startedAt: "2026-09-29T00:00:00.000Z",
  ...over,
})

interface Calls {
  lines: string[]
  served: string[][]
  spawned: string[][]
  killed: Array<[number, string]>
}

function harness(over: Partial<StartDeps> & { plugins?: BureauPlugin[] } = {}): { deps: StartDeps; calls: Calls } {
  const calls: Calls = { lines: [], served: [], spawned: [], killed: [] }
  const { plugins: _plugins, ...rest } = over
  const deps: StartDeps = {
    home: tmp.home,
    env: {},
    registry: createBureauBrowserRegistry({ plugins: [] }),
    sleep: async () => {},
    pollMs: 1,
    isAlive: () => false,
    kill: (pid, sig) => void calls.killed.push([pid, sig]),
    runServe: async args => void calls.served.push(args),
    spawnServe: args => (calls.spawned.push(args), { pid: 777 }),
    log: line => void calls.lines.push(line),
    fetch: scriptedFetch([null]),
    ...rest,
  }
  return { deps, calls }
}

const text = (c: Calls): string => c.lines.join("\n")

describe("bureau start: idempotent reuse", () => {
  it("reuses a Bureau that already answers, without serving or spawning", async () => {
    const { deps, calls } = harness({ fetch: scriptedFetch([healthy()]) })
    expect(await runStart(["--port", "18830"], [], deps)).toBe(0)
    expect(calls.served).toHaveLength(0)
    expect(calls.spawned).toHaveLength(0)
    expect(text(calls)).toContain("already running")
  })

  it("accepts the camoufox spelling and the camofox positional for the same browser", async () => {
    for (const argv of [["--browser", "camoufox"], ["camofox"]]) {
      const { deps, calls } = harness({ fetch: scriptedFetch([healthy()]) })
      expect(await runStart(argv, [], deps)).toBe(0)
      expect(calls.served).toHaveLength(0)
    }
  })

  it("refuses to reuse a Bureau running a different browser and points at bureau stop", async () => {
    const { deps, calls } = harness({ fetch: scriptedFetch([healthy("chrome")]) })
    expect(await runStart(["--browser", "camofox"], [], deps)).toBe(1)
    expect(text(calls)).toMatch(/browser chrome, not camofox.*bureau stop/)
    expect(calls.served).toHaveLength(0)
  })
})

describe("bureau start: launching", () => {
  it("serves in this process with the resolved flags", async () => {
    const { deps, calls } = harness()
    const code = await runStart(["--browser", "camoufox", "--headless", "--profile", "work", "--port", "18830", "--timeout", "30"], [], deps)
    expect(code).toBe(0)
    expect(calls.served).toHaveLength(1)
    const args = calls.served[0]!
    expect(args).toEqual(expect.arrayContaining(["--port", "18830", "--browser", "camofox", "--headless", "--profile", "work", "--timeout", "30"]))
  })

  it("passes bureau-only through as --no-browser and no browser flag", async () => {
    const { deps, calls } = harness()
    expect(await runStart(["bureau-only", "--port", "18830"], [], deps)).toBe(0)
    expect(calls.served[0]).toContain("--no-browser")
    expect(calls.served[0]).not.toContain("--browser")
  })

  it("rejects an unknown browser id and lists the registered ones", async () => {
    const { deps, calls } = harness()
    expect(await runStart(["--browser", "netscape"], [], deps)).toBe(1)
    expect(text(calls)).toContain("netscape")
    for (const id of ["camofox", "chrome", "chromium"]) expect(text(calls)).toContain(id)
    expect(calls.served).toHaveLength(0)
  })

  it("rejects conflicting flags before doing anything", async () => {
    const { deps, calls } = harness()
    expect(await runStart(["--headless", "--headed"], [], deps)).toBe(1)
    expect(text(calls)).toContain("mutually exclusive")
    expect(calls.served).toHaveLength(0)
  })

  it("launches a third-party provider selected by id", async () => {
    const { provider } = createFakeBrowserProvider({ id: "acme-browser" })
    const plugin: BureauPlugin = { name: "acme", entries: () => [], browsers: [provider] }
    const registry = createBureauBrowserRegistry({ plugins: [plugin] })
    const { deps, calls } = harness({ registry })
    expect(await runStart(["--browser", "acme-browser", "--port", "18830"], [plugin], deps)).toBe(0)
    expect(calls.served[0]).toEqual(expect.arrayContaining(["--browser", "acme-browser"]))
  })

  it("does not start chrome with the default profile name: the request reaches serve, where the provider refuses (F11)", async () => {
    const chrome = createChromeHarness(`${tmp.home}/chrome-data`)
    const registry = createBureauBrowserRegistry({ builtins: [chrome.provider] })
    const { deps, calls } = harness({ registry })
    await runStart(["--browser", "chrome", "--profile", "Default"], [], deps)
    expect(chrome.spawns).toHaveLength(0)
    expect(calls.served[0]).toEqual(expect.arrayContaining(["--profile", "Default"]))
  })
})

describe("bureau start: crash-looping browser", () => {
  it("stops the Bureau it started and starts a fresh one, which resets the loop", async () => {
    let alive = true
    const { deps, calls } = harness({
      fetch: scriptedFetch([healthy("camofox", "crash-looping")]),
      isAlive: () => alive,
      kill: (pid, sig) => {
        calls.killed.push([pid, sig])
        alive = false
      },
    })
    await writeRunState(tmp.home, runState())
    expect(await runStart(["--port", "18830"], [], deps)).toBe(0)
    expect(calls.killed).toEqual([[424242, "SIGTERM"]])
    expect(calls.served).toHaveLength(1)
    expect(text(calls)).toContain("crash-looping")
  })

  it("leaves a crash-looping Bureau that bureau start did not start alone", async () => {
    const { deps, calls } = harness({ fetch: scriptedFetch([healthy("camofox", "crash-looping")]) })
    expect(await runStart(["--port", "18830"], [], deps)).toBe(1)
    expect(calls.killed).toHaveLength(0)
    expect(calls.served).toHaveLength(0)
  })

  it("does not signal a state file from another port", async () => {
    const { deps, calls } = harness({ fetch: scriptedFetch([healthy("camofox", "crash-looping")]), isAlive: () => true })
    await writeRunState(tmp.home, runState({ port: 9999 }))
    expect(await runStart(["--port", "18830"], [], deps)).toBe(1)
    expect(calls.killed).toHaveLength(0)
  })
})

describe("bureau start --detach", () => {
  it("spawns serve and reports success once health settles", async () => {
    const { deps, calls } = harness({ fetch: scriptedFetch([null, healthy("camofox", "starting"), healthy()]) })
    expect(await runStart(["--detach", "--port", "18830"], [], deps)).toBe(0)
    expect(calls.spawned).toHaveLength(1)
    expect(calls.spawned[0]).toEqual(expect.arrayContaining(["--port", "18830", "--browser", "camofox"]))
    expect(text(calls)).toContain("healthy on :18830")
  })

  it("reports the launch error the server left in the state file", async () => {
    const { deps, calls } = harness({
      spawnServe: async_ => {
        calls.spawned.push(async_)
        void writeRunState(tmp.home, runState({ error: "profile refused: Default" }))
        return { pid: 777 }
      },
      sleep: () => new Promise(r => setTimeout(r, 20)),
    })
    expect(await runStart(["--detach", "--browser", "chrome", "--port", "18830"], [], deps)).toBe(1)
    expect(text(calls)).toContain("profile refused: Default")
  })

  it("ignores a dead Bureau's leftover error", async () => {
    const { deps, calls } = harness({ fetch: scriptedFetch([null, healthy()]) })
    await writeRunState(tmp.home, runState({ error: "old failure" }))
    expect(await runStart(["--detach", "--port", "18830"], [], deps)).toBe(0)
    expect(text(calls)).not.toContain("old failure")
  })

  it("reports a browser that is crash-looping after start", async () => {
    const { deps, calls } = harness({ fetch: scriptedFetch([null, healthy("camofox", "crash-looping")]) })
    expect(await runStart(["--detach", "--port", "18830"], [], deps)).toBe(1)
    expect(text(calls)).toContain("run \"bureau start\" again")
  })

  it("times out when health never settles", async () => {
    const { deps, calls } = harness({ fetch: scriptedFetch([null]), sleep: () => new Promise(r => setTimeout(r, 5)) })
    expect(await runStart(["--detach", "--port", "18830", "--timeout", "0.05"], [], deps)).toBe(1)
    expect(text(calls)).toContain("did not settle")
  })

  it("writes nothing but the state file the server owns (no secrets in the file)", async () => {
    await writeRunState(tmp.home, runState())
    const raw = readFileSync(runStatePath(tmp.home), "utf8")
    expect(raw).not.toMatch(/token|bearer|cookie|secret/i)
  })
})

describe("bureau start --help", () => {
  it("prints usage without em dashes", async () => {
    const { deps, calls } = harness()
    expect(await runStart(["--help"], [], deps)).toBe(0)
    expect(text(calls)).toContain("--detach")
    expect(text(calls)).not.toContain("—")
  })
})
