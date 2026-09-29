import { existsSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BROWSER_PROFILE_REFUSED_CODE, createFakeBrowserProvider, type BrowserProvider } from "@agentproto/driver-browser"
import { createCamofoxHarness, createChromeHarness, createChromiumHarness, type CamofoxHarness } from "./__tests__/support/browser-fakes.js"
import { bootServe, healthOf, loopbackPlugin, registryOver, tempHome, type Booted, type TempHome } from "./__tests__/support/serve-harness.js"
import { readRunState, runStatePath } from "./lib/run-state.js"
import { rawRequest } from "./__tests__/support/http.js"

let tmp: TempHome
let booted: Booted | undefined
let camofox: CamofoxHarness | undefined

beforeEach(() => {
  tmp = tempHome()
})
afterEach(async () => {
  await booted?.handle.close().catch(() => {})
  booted = undefined
  await camofox?.dispose()
  camofox = undefined
  tmp.cleanup()
})

const CMD = ["--camofox-cmd", "fake-camofox serve"]
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const waitFor = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 10))
}

describe("/health", () => {
  it("keeps ok and tools and adds only the supervisor fields", async () => {
    camofox = await createCamofoxHarness("ok")
    booted = await bootServe({ argv: CMD, registry: registryOver(camofox.provider), home: tmp.home })
    await booted.handle.browserReady
    const { status, body } = await healthOf(booted.port)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.tools).toBeGreaterThan(0)
    expect(Object.keys(body).sort()).toEqual(["browser", "ok", "restarts", "since", "state", "tools", "wasAlreadyRunning"])
    expect(body).toMatchObject({ browser: "camofox", state: "healthy", restarts: 0, wasAlreadyRunning: true })
    expect(Number.isNaN(Date.parse(body.since))).toBe(false)
  })

  it("answers `starting` while the launch is pending, then `healthy`", async () => {
    camofox = await createCamofoxHarness("down")
    let release: () => void = () => {}
    const gate = new Promise<void>(r => (release = r))
    const slow: BrowserProvider = { ...camofox.provider, launch: async (o, c) => (await gate, camofox!.provider.launch(o, c)) }
    booted = await bootServe({ argv: CMD, registry: registryOver(slow), home: tmp.home })
    const early = await healthOf(booted.port)
    expect(early.status).toBe(200)
    expect(early.body).toMatchObject({ ok: true, browser: "camofox", state: "starting" })
    release()
    await booted.handle.browserReady
    expect((await healthOf(booted.port)).body.state).toBe("healthy")
  })

  it("reports a Bureau started with --no-browser as stopped and unmanaged", async () => {
    camofox = await createCamofoxHarness("ok")
    booted = await bootServe({ argv: ["--no-browser"], registry: registryOver(camofox.provider), home: tmp.home })
    await booted.handle.browserReady
    const { status, body } = await healthOf(booted.port)
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, browser: "camofox", state: "stopped", restarts: 0, wasAlreadyRunning: false })
    expect(camofox.spawns).toHaveLength(0)
  })
})

describe("launch is idempotent", () => {
  it("reuses a healthy camofox without spawning, records it as not owned, and leaves it running on close", async () => {
    camofox = await createCamofoxHarness("ok")
    booted = await bootServe({ argv: CMD, registry: registryOver(camofox.provider), home: tmp.home })
    await booted.handle.browserReady
    expect(camofox.spawns).toHaveLength(0)
    const state = await readRunState(tmp.home)
    expect(state).toMatchObject({ browser: "camofox", browserOwned: false, pid: process.pid })
    await booted.handle.close()
    expect(camofox.fake.listening).toBe(true)
    expect(existsSync(runStatePath(tmp.home))).toBe(false)
  })

  it("spawns once when camofox is down, owns it, and stops only what it started", async () => {
    camofox = await createCamofoxHarness("down")
    booted = await bootServe({ argv: CMD, registry: registryOver(camofox.provider), home: tmp.home })
    await booted.handle.browserReady
    expect(camofox.spawns).toHaveLength(1)
    expect(JSON.stringify(camofox.spawns[0])).toContain("fake-camofox serve")
    const { body } = await healthOf(booted.port)
    expect(body).toMatchObject({ state: "healthy", wasAlreadyRunning: false })
    const state = await readRunState(tmp.home)
    expect(state?.browserOwned).toBe(true)
    const pid = state?.browserPid ?? 0
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(true)
    await booted.handle.close()
    await waitFor(() => !alive(pid))
    expect(alive(pid)).toBe(false)
  })
})

describe("chrome and chromium use a fresh dedicated profile (F11)", () => {
  it("launches chrome headless on a dir under the data dir, never the default profile, and kills it on close", async () => {
    const chrome = createChromeHarness(join(tmp.home, "chrome-data"))
    booted = await bootServe({ argv: ["--browser", "chrome", "--headless", "--profile", "work"], registry: registryOver(chrome.provider), home: tmp.home })
    await booted.handle.browserReady
    expect(chrome.spawns).toHaveLength(1)
    const args = chrome.spawns[0]!.args
    const dir = args.find(a => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length)
    expect(realpathSync(dir).startsWith(realpathSync(join(tmp.home, "chrome-data")))).toBe(true)
    expect(dir).not.toMatch(/Google\/Chrome$|google-chrome$/)
    expect(args).toContain("--headless=new")
    expect((await healthOf(booted.port)).body).toMatchObject({ browser: "chrome", state: "healthy", wasAlreadyRunning: false })
    await booted.handle.close()
    expect(chrome.killed).toBe(1)
  })

  it("launches chromium on a dedicated dir and closes its context", async () => {
    const chromium = createChromiumHarness(join(tmp.home, "chromium-data"))
    booted = await bootServe({ argv: ["--browser", "chromium", "--headed"], registry: registryOver(chromium.provider), home: tmp.home })
    await booted.handle.browserReady
    expect(chromium.launches).toHaveLength(1)
    expect(realpathSync(chromium.launches[0]!.dir).startsWith(realpathSync(join(tmp.home, "chromium-data")))).toBe(true)
    expect(chromium.launches[0]?.headless).toBe(false)
    expect((await healthOf(booted.port)).body).toMatchObject({ browser: "chromium", state: "healthy" })
    await booted.handle.close()
    expect(chromium.closed).toBe(1)
  })

  it.each([["chrome"], ["chromium"]])("refuses the default profile name for %s, spawns nothing, and exits with the error kept", async id => {
    const chrome = createChromeHarness(join(tmp.home, "chrome-data"))
    const chromium = createChromiumHarness(join(tmp.home, "chromium-data"))
    booted = await bootServe({
      argv: ["--browser", id, "--profile", "Default"],
      registry: registryOver(chrome.provider, chromium.provider),
      home: tmp.home,
    })
    await booted.handle.browserReady
    expect(chrome.spawns).toHaveLength(0)
    expect(chromium.launches).toHaveLength(0)
    expect(booted.fatal).toHaveLength(1)
    expect((booted.fatal[0] as Error & { code?: string }).code).toBe(BROWSER_PROFILE_REFUSED_CODE)
    const state = await readRunState(tmp.home)
    expect(state?.error).toContain("Default")
  })

  it("refuses a full-profile launch without an active recorded grant", async () => {
    const chrome = createChromeHarness(join(tmp.home, "chrome-data"))
    await expect(bootServe({ argv: ["--browser", "chrome", "--full-profile", "no-such-grant"], registry: registryOver(chrome.provider), home: tmp.home })).rejects.toThrow(/full-profile/)
    expect(chrome.spawns).toHaveLength(0)
  })
})

describe("crash loop", () => {
  it("reports crash-looping, stops retrying, keeps answering /health, and a restart resets it", async () => {
    const options = { serveOnSpawn: false, ownedPid: false }
    camofox = await createCamofoxHarness("down", options)
    booted = await bootServe({ argv: [...CMD, "--timeout", "0.05"], registry: registryOver(camofox.provider), home: tmp.home })
    const runtime = booted.handle.runtime!
    await booted.handle.browserReady
    expect(runtime.status().state).toBe("crash-looping")

    const spawnsAtLoop = camofox.spawns.length
    expect(spawnsAtLoop).toBe(3)
    await new Promise(r => setTimeout(r, 200))
    expect(camofox.spawns.length).toBe(spawnsAtLoop)

    const { status, body } = await healthOf(booted.port)
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, browser: "camofox", state: "crash-looping" })
    expect(body.restarts).toBeGreaterThanOrEqual(2)
    expect((await rawRequest(booted.port, "GET", "/health")).status).toBe(200)

    await expect(runtime.start()).rejects.toMatchObject({ code: "browser:crash-looping" })
    expect(camofox.spawns.length).toBe(spawnsAtLoop)

    options.serveOnSpawn = true
    options.ownedPid = true
    await runtime.restart()
    expect(camofox.spawns.length).toBe(spawnsAtLoop + 1)
    expect((await healthOf(booted.port)).body.state).toBe("healthy")
  })

  it("keeps Bureau up when a non-fatal launch failure happens once", async () => {
    camofox = await createCamofoxHarness("down", { serveOnSpawn: false, ownedPid: false })
    booted = await bootServe({ argv: [...CMD, "--timeout", "0.05"], registry: registryOver(camofox.provider), home: tmp.home })
    await booted.handle.browserReady
    expect(booted.fatal).toHaveLength(0)
    expect((await healthOf(booted.port)).status).toBe(200)
  })
})

describe("third-party provider", () => {
  it("is selectable by id through a plugin, launched, and reported by /health", async () => {
    const { provider, state } = createFakeBrowserProvider({ id: "acme-browser" })
    booted = await bootServe({
      argv: ["--browser", "acme-browser"],
      home: tmp.home,
      plugins: [loopbackPlugin, { name: "acme", entries: () => [], browsers: [provider] }],
    })
    await booted.handle.browserReady
    expect(state.launches).toBe(1)
    expect((await healthOf(booted.port)).body).toMatchObject({ browser: "acme-browser", state: "healthy" })
  })
})
