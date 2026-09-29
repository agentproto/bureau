/**
 * `bureau start` — launch the selected browser and the Bureau server in one shot.
 *
 *   bureau start [<browser>] [options]
 *
 * The browser is resolved by id through the kit registry, so a provider a
 * plugin registers is selectable exactly like the built-ins. Launch is
 * idempotent: a Bureau that already answers `/health` is reused, never
 * respawned, and a healthy browser server is reused by the provider.
 */

import { spawn } from "node:child_process"
import type { BrowserRegistry } from "@agentproto/driver-browser"
import { parseArgs, out } from "../lib/args.js"
import { bureauHome } from "../lib/pairing.js"
import { createBureauBrowserRegistry, DEFAULT_BROWSER_ID } from "../lib/browser-registry.js"
import { BrowserFlagError, browserFlagsFrom, chooseBrowserId, planBrowserLaunch } from "../lib/browser-launch.js"
import { pidAlive, readRunState, removeRunState } from "../lib/run-state.js"
import { loadPlugins, pluginSpecs, type BureauPlugin } from "../plugin.js"

const USAGE = `bureau start: launch a browser and the Bureau server in one command

  bureau start [<browser>] [options]

  <browser>             camofox (default) | chrome | chromium | <registered id> | bureau-only
                        (bureau-only: the browser is managed elsewhere and Bureau does not start it)

  --browser ID          same as <browser>; camoufox is accepted for camofox
  --headless | --headed run the browser without or with a window
  --profile NAME        a dedicated profile name (chrome and chromium always use a fresh
                        dedicated dir, never your Chrome profile)
  --full-profile ID     use a recorded full-profile grant (bureau session import ...)
  --port N              Bureau server port (default BUREAU_PORT/PORT env or 8830)
  --browser-port N      the browser's port (camofox default 9377; alias --camofox-port)
  --camofox-cmd CMD     override the camofox launch command (else CAMOFOX_SERVE_CMD / launchctl)
  --detach              run Bureau in the background, write the state file, exit once settled
  --timeout N           max wait seconds (default 60)
  --plugin PATH|PKG     load a plugin (repeatable)
  --help

Stop what this started with: bureau stop`

const PREFIX = "[bureau start]"

export interface SpawnedServe {
  pid?: number
}

export interface StartDeps {
  registry?: BrowserRegistry
  home?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  /** Spawn a detached `bureau serve` with these args and env. */
  spawnServe?: (args: string[], env: NodeJS.ProcessEnv) => SpawnedServe
  isAlive?: (pid: number) => boolean
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** Run the server in this process (default: the real `runServe`). */
  runServe?: (args: string[], plugins: readonly BureauPlugin[]) => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  log?: (line: string) => void
}

const defaultSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

interface HealthBody {
  ok?: boolean
  tools?: number
  browser?: string
  state?: string
}

async function readHealth(url: string, doFetch: typeof fetch): Promise<HealthBody | null> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 3000)
  try {
    const r = await doFetch(url, { signal: ac.signal })
    if (!r.ok) return null
    return (await r.json()) as HealthBody
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

function serveArgs(input: {
  flags: Record<string, string>
  browserId: string
  managed: boolean
  port: number
  pluginArgs: string[]
}): string[] {
  const args = ["--port", String(input.port), ...input.pluginArgs]
  if (!input.managed) return [...args, "--no-browser"]
  args.push("--browser", input.browserId)
  for (const name of ["headless", "headed"]) if (input.flags[name] !== undefined) args.push(`--${name}`)
  for (const name of ["profile", "full-profile", "browser-port", "camofox-port", "camofox-cmd", "timeout", "host"]) {
    const v = input.flags[name]
    if (v !== undefined) args.push(`--${name}`, v)
  }
  return args
}

export async function runStart(
  argv: string[],
  extraPlugins: readonly BureauPlugin[] = [],
  deps: StartDeps = {}
): Promise<number> {
  const say = deps.log ?? out
  const log = (s: string): void => say(`${PREFIX} ${s}`)
  const env = deps.env ?? process.env
  const doFetch = deps.fetch ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const isAlive = deps.isAlive ?? pidAlive
  const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals): void => void process.kill(pid, sig))

  const { positionals, flags } = parseArgs(argv)
  if (flags["help"]) {
    say(USAGE)
    return 0
  }

  try {
    const positional = positionals[0]
    const managed = positional !== "bureau-only" && flags["no-browser"] !== "true"
    const browserFlags = browserFlagsFrom(flags)
    const plugins = [...extraPlugins, ...(await loadPlugins(pluginSpecs(argv, {})))]
    const registry = deps.registry ?? createBureauBrowserRegistry({ plugins })
    const browserId = chooseBrowserId(browserFlags, env, positional === "bureau-only" ? undefined : positional)
    // Validate the request against the provider's manifest before anything is spawned.
    // The grant itself is looked up by the server, which owns the consent host.
    const plan = planBrowserLaunch({
      registry,
      id: managed ? browserId : DEFAULT_BROWSER_ID,
      flags: managed ? browserFlags : {},
      env,
      fullProfileProof: grantId => ({ grantId, isActive: () => false }),
    })

    const port = Number(flags["port"] ?? env["BUREAU_PORT"] ?? env["PORT"] ?? 8830)
    const home = deps.home ?? bureauHome(env)
    const healthUrl = `http://127.0.0.1:${port}/health`
    const detach = flags["detach"] === "true" || flags["detach"] === ""
    const timeoutMs = Number(flags["timeout"] ?? 60) * 1000
    const pollMs = deps.pollMs ?? 1000
    const pluginArgs = pluginSpecs(argv, {}).flatMap(s => ["--plugin", s])

    // ── Idempotent: a Bureau that already answers is reused ────────────────────
    const running = await readHealth(healthUrl, doFetch)
    if (running) {
      if (running.state === "crash-looping") {
        const state = await readRunState(home)
        if (!state || state.port !== port || !isAlive(state.pid)) {
          log(`bureau on :${port} reports its browser is crash-looping, but it was not started by bureau start, so it is left alone`)
          return 1
        }
        log(`browser ${running.browser ?? "?"} is crash-looping; restarting bureau (pid ${state.pid}) to reset it`)
        kill(state.pid, "SIGTERM")
        const deadline = Date.now() + 15_000
        while (isAlive(state.pid) && Date.now() < deadline) await sleep(100)
        if (isAlive(state.pid)) {
          log(`pid ${state.pid} did not exit in 15s`)
          return 1
        }
      } else {
        if (managed && running.browser !== undefined && running.browser !== plan.provider.id) {
          log(`bureau is already running on :${port} with browser ${running.browser}, not ${plan.provider.id}; run "bureau stop" first`)
          return 1
        }
        log(`bureau already running on :${port} (browser ${running.browser ?? "unknown"}, ${running.state ?? "unknown"}), reusing it`)
        return 0
      }
    }

    const args = serveArgs({ flags, browserId: plan.provider.id, managed, port, pluginArgs })

    if (!detach) {
      const run = deps.runServe ?? (async (a: string[], p: readonly BureauPlugin[]): Promise<unknown> => (await import("../serve.js")).runServe(a, p))
      await run(args, extraPlugins)
      return 0
    }

    // A dead Bureau's leftover state (possibly carrying its launch error) must not be mistaken for this run's.
    const prior = await readRunState(home)
    if (prior && !isAlive(prior.pid)) await removeRunState(home)

    const spawnServe =
      deps.spawnServe ??
      ((a: string[], e: NodeJS.ProcessEnv): SpawnedServe => {
        const child = spawn(process.execPath, [process.argv[1]!, "serve", ...a], { detached: true, stdio: "ignore", env: e })
        child.unref()
        return child
      })
    const child = spawnServe(args, { ...env, PORT: String(port) })
    log(`bureau serve spawned (pid ${child.pid ?? "unknown"}), waiting for health on :${port}`)

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(pollMs)
      const state = await readRunState(home)
      if (state?.error !== undefined) {
        log(`bureau could not start the browser: ${state.error}`)
        return 1
      }
      const health = await readHealth(healthUrl, doFetch)
      if (!health || health.state === "starting") continue
      if (health.state === "crash-looping") {
        log(`browser ${health.browser ?? "?"} is crash-looping; bureau is up, run "bureau start" again to reset it`)
        return 1
      }
      const tools = typeof health.tools === "number" ? `, ${health.tools} tools` : ""
      log(`bureau healthy on :${port} (browser ${health.browser ?? "?"}, ${health.state ?? "unknown"}${tools})`)
      return 0
    }
    log(`bureau did not settle on :${port} within ${timeoutMs / 1000}s`)
    return 1
  } catch (err) {
    log(err instanceof BrowserFlagError || err instanceof Error ? err.message : String(err))
    return 1
  }
}
