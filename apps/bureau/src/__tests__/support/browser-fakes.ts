/**
 * Fakes for the three local browser providers. Nothing here launches a real
 * browser: camofox is a tiny REST `/health` server plus a counting `spawn`,
 * chrome is a `spawn` that writes `DevToolsActivePort`, chromium is a
 * Playwright loader returning a fake persistent context. Ports are random
 * 127.0.0.1 ports and every directory is the caller's temp dir.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { join } from "node:path"
import type { BrowserProvider } from "@agentproto/driver-browser"
import { createCamofoxProvider } from "@agentproto/adapter-browser-camofox"
import { createChromeProvider, type ChromeProcess } from "@agentproto/adapter-browser-chrome"
import { createChromiumProvider } from "@agentproto/adapter-browser-chromium"
import { freePort } from "./http.js"

export type FakeHealthMode = "ok" | "idle" | "launching" | "crash-looping"

/** A camofox `/health` server that can be started later, as a spawn would. */
export interface FakeCamofox {
  readonly port: number
  readonly baseUrl: string
  readonly listening: boolean
  healthHits: number
  setHealth(mode: FakeHealthMode): void
  listen(): Promise<void>
  close(): Promise<void>
}

function healthOf(mode: FakeHealthMode): { status: number; body: Record<string, unknown> } {
  const base = { engine: "camoufox", bootId: "boot-fake-1", startedAt: "2026-09-29T08:00:00.000Z" }
  switch (mode) {
    case "ok":
      return { status: 200, body: { ...base, ok: true, browserState: "running" } }
    case "idle":
      return { status: 200, body: { ...base, ok: true, browserState: "idle" } }
    case "launching":
      return { status: 503, body: { ...base, ok: false, browserState: "launching" } }
    case "crash-looping":
      return { status: 503, body: { ...base, ok: false, browserState: "crash-looping", consecutiveLaunchFailures: 4 } }
  }
}

export async function createFakeCamofox(mode: FakeHealthMode = "ok"): Promise<FakeCamofox> {
  const port = await freePort()
  let current = mode
  let server: Server | undefined
  const fake: FakeCamofox = {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    get listening() {
      return server?.listening === true
    },
    healthHits: 0,
    setHealth(next) {
      current = next
    },
    listen() {
      if (server?.listening) return Promise.resolve()
      const s = createServer((req, res) => {
        if (req.url === "/health") {
          fake.healthHits += 1
          const h = healthOf(current)
          res.writeHead(h.status, { "content-type": "application/json" })
          res.end(JSON.stringify(h.body))
          return
        }
        res.writeHead(404).end()
      })
      server = s
      return new Promise<void>((resolve, reject) => {
        s.once("error", reject)
        s.listen(port, "127.0.0.1", () => resolve())
      })
    },
    close() {
      const s = server
      server = undefined
      return new Promise<void>(resolve => (s?.listening ? s.close(() => resolve()) : resolve()))
    },
  }
  return fake
}

const noPersisted = async (): Promise<Record<string, string>> => ({})
const instant = (): Promise<void> => Promise.resolve()

/** Harmless real child so a provider's `stop()` has an owned pid to signal. */
export interface Sleeper {
  child: ChildProcess
  readonly pid: number
  kill(): void
}

export function startSleeper(): Sleeper {
  const child = nodeSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  return {
    child,
    get pid() {
      return child.pid ?? 0
    },
    kill: () => void child.kill("SIGKILL"),
  }
}

export interface CamofoxFakeOptions {
  /** Bring the fake server up when the provider spawns (default true). false simulates a launcher that dies. */
  serveOnSpawn?: boolean
  /** Give the spawn a real owned pid (a sleeper) so stop() can signal it. */
  ownedPid?: boolean
}

export interface CamofoxHarness {
  fake: FakeCamofox
  provider: BrowserProvider
  spawns: Array<{ file: string; args: string[] }>
  sleepers: Sleeper[]
  /** Kills every sleeper this harness started. */
  dispose(): Promise<void>
}

export async function createCamofoxHarness(mode: FakeHealthMode | "down" = "down", options: CamofoxFakeOptions = {}): Promise<CamofoxHarness> {
  const fake = await createFakeCamofox(mode === "down" ? "ok" : mode)
  if (mode !== "down") await fake.listen()
  const spawns: Array<{ file: string; args: string[] }> = []
  const sleepers: Sleeper[] = []
  const provider = createCamofoxProvider({
    baseUrl: fake.baseUrl,
    platform: "linux",
    readPersistedEnv: noPersisted,
    pollIntervalMs: 5,
    sleep: (ms: number) => new Promise(r => setTimeout(r, Math.min(ms, 5))),
    spawn: (file, args) => {
      spawns.push({ file, args })
      if (options.serveOnSpawn !== false) void fake.listen()
      if (options.ownedPid === false) return { unref() {} }
      const sleeper = startSleeper()
      sleepers.push(sleeper)
      return { pid: sleeper.pid, unref() {} }
    },
  }) as unknown as BrowserProvider
  return {
    fake,
    provider,
    spawns,
    sleepers,
    async dispose() {
      for (const s of sleepers) s.kill()
      await fake.close()
    },
  }
}

export interface ChromeHarness {
  provider: BrowserProvider
  spawns: Array<{ file: string; args: string[] }>
  killed: number
}

/** A Chrome whose "process" writes DevToolsActivePort into the requested dedicated dir. */
export function createChromeHarness(dataDir: string): ChromeHarness {
  const spawns: Array<{ file: string; args: string[] }> = []
  const harness: ChromeHarness = { provider: undefined as unknown as BrowserProvider, spawns, killed: 0 }
  harness.provider = createChromeProvider({
    dataDir,
    executablePath: "/fake/Google Chrome",
    sleep: instant,
    spawn: (file, args): ChromeProcess => {
      spawns.push({ file, args })
      const arg = args.find(a => a.startsWith("--user-data-dir="))
      const dir = arg?.slice("--user-data-dir=".length)
      if (dir) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "DevToolsActivePort"), "9333\n/devtools/browser/fake\n")
      }
      const listeners: Array<() => void> = []
      return {
        pid: 4_000_000,
        kill() {
          harness.killed += 1
          for (const l of listeners) l()
          return true
        },
        once(_event, listener) {
          listeners.push(listener)
        },
      }
    },
  }) as unknown as BrowserProvider
  return harness
}

export interface ChromiumHarness {
  provider: BrowserProvider
  launches: Array<{ dir: string; headless: boolean | undefined }>
  closed: number
}

/** A Chromium whose Playwright is a fake persistent context that writes DevToolsActivePort. */
export function createChromiumHarness(dataDir: string): ChromiumHarness {
  const launches: Array<{ dir: string; headless: boolean | undefined }> = []
  const harness: ChromiumHarness = { provider: undefined as unknown as BrowserProvider, launches, closed: 0 }
  harness.provider = createChromiumProvider({
    dataDir,
    sleep: instant,
    loadPlaywright: async () =>
      ({
        chromium: {
          launchPersistentContext: async (dir: string, opts: { headless?: boolean }) => {
            launches.push({ dir, headless: opts.headless })
            mkdirSync(dir, { recursive: true })
            writeFileSync(join(dir, "DevToolsActivePort"), "9444\n/devtools/browser/fake\n")
            const closeListeners: Array<() => void> = []
            return {
              on(event: string, listener: () => void) {
                if (event === "close") closeListeners.push(listener)
              },
              async close() {
                harness.closed += 1
                for (const l of closeListeners) l()
              },
            }
          },
        },
      }) as never,
  }) as unknown as BrowserProvider
  return harness
}
