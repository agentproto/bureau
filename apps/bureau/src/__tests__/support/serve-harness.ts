import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserProvider } from "@agentproto/driver-browser"
import { allowLoopback } from "../../lib/mcp-server.js"
import { createBureauBrowserRegistry } from "../../lib/browser-registry.js"
import { runServe, type ServeDeps, type ServeHandle } from "../../serve.js"
import type { BureauPlugin } from "../../plugin.js"
import { freePort, rawRequest } from "./http.js"

/** The studio flavour: `authorize: allowLoopback`, so no pairing registry or control socket starts. */
export const loopbackPlugin: BureauPlugin = { name: "loopback-test", entries: () => [], authorize: allowLoopback }

export interface HealthJson {
  ok: boolean
  tools: number
  browser: string
  state: "starting" | "healthy" | "degraded" | "crash-looping" | "stopped"
  restarts: number
  wasAlreadyRunning: boolean
  since: string
}

export async function healthOf(port: number): Promise<{ status: number; body: HealthJson }> {
  const res = await rawRequest(port, "GET", "/health")
  return { status: res.status, body: JSON.parse(res.body) as HealthJson }
}

/** Tight supervisor timings so a crash loop plays out in milliseconds. */
export const FAST_RUNTIME: NonNullable<ServeDeps["runtime"]> = {
  healthIntervalMs: 60_000,
  crashLoop: { maxFailures: 3, windowMs: 60_000, retryDelayMs: 5 },
  launchBudgetMs: 5_000,
}

export interface Booted {
  handle: ServeHandle
  port: number
  home: string
  fatal: Error[]
  logs: string[]
}

export interface TempHome {
  home: string
  cleanup(): void
}

export function tempHome(prefix = "bureau-home-"): TempHome {
  const home = mkdtempSync(join(tmpdir(), prefix))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

export function registryOver(...providers: BrowserProvider[]): ReturnType<typeof createBureauBrowserRegistry> {
  return createBureauBrowserRegistry({ builtins: providers })
}

export async function bootServe(input: {
  argv: string[]
  registry?: ReturnType<typeof createBureauBrowserRegistry>
  home: string
  plugins?: readonly BureauPlugin[]
  runtime?: ServeDeps["runtime"]
}): Promise<Booted> {
  const port = await freePort()
  const fatal: Error[] = []
  const logs: string[] = []
  const handle = await runServe(["--port", String(port), ...input.argv], input.plugins ?? [loopbackPlugin], {
    ...(input.registry ? { registry: input.registry } : {}),
    home: input.home,
    env: {},
    installProcessHandlers: false,
    runtime: input.runtime ?? FAST_RUNTIME,
    log: line => logs.push(line),
    onFatal: e => fatal.push(e),
  })
  return { handle, port: handle.port, home: input.home, fatal, logs }
}
