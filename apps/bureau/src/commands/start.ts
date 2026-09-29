/**
 * `bureau start` — orchestrate Camofox headless + bureau serve in one shot.
 *
 *   bureau start [<adapter>] [options]
 *
 *   <adapter>            camofox (default) | bureau-only (Camofox assumed up)
 *   --camofox-port N     Camofox port (default 9377)
 *   --port N             bureau serve port (default BUREAU_PORT/PORT env or 8830)
 *   --camofox-cmd CMD    override Camofox launch command (else CAMOFOX_SERVE_CMD / launchctl)
 *   --detach             spawn bureau serve detached, exit 0 once healthy
 *   --timeout N          max wait seconds (default 60)
 */

import { spawn } from "node:child_process"
import { parseArgs, out } from "../lib/args.js"
import { ensureCamofox } from "../lib/ensure-camofox.js"
import { pluginSpecs, type BureauPlugin } from "../plugin.js"

const USAGE = `bureau start — orchestrate Camofox + bureau serve in one command

  bureau start [<adapter>] [options]

  <adapter>             camofox (default) | bureau-only (Camofox assumed up)

  --camofox-port N      Camofox port (default 9377)
  --port N              bureau serve port (default BUREAU_PORT/PORT env or 8830)
  --camofox-cmd CMD     override Camofox launch command (else CAMOFOX_SERVE_CMD / launchctl)
  --detach              spawn bureau serve detached, exit 0 once healthy
  --timeout N           max wait seconds (default 60)
  --help`

const PREFIX = "[bureau start]"
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function log(s: string): void {
  out(`${PREFIX} ${s}`)
}

async function waitHealthy(
  url: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(1000)
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 3000)
    try {
      const r = await fetch(url, { signal: ac.signal })
      if (r.ok) return (await r.json()) as Record<string, unknown>
    } catch {
      // not yet healthy
    } finally {
      clearTimeout(t)
    }
  }
  throw new Error(
    `bureau serve did not become healthy at ${url} within ${timeoutMs / 1000}s`
  )
}

export async function runStart(
  argv: string[],
  extraPlugins: readonly BureauPlugin[] = []
): Promise<number> {
  const { positionals, flags } = parseArgs(argv)

  if (flags.help) {
    out(USAGE)
    return 0
  }

  const adapter = positionals[0] ?? "camofox"
  if (adapter !== "camofox" && adapter !== "bureau-only") {
    out(
      `${PREFIX} unknown adapter "${adapter}" — use camofox (default) or bureau-only`
    )
    return 1
  }

  const camofoxPort = Number(flags["camofox-port"] ?? 9377)
  const bureauPort = Number(
    flags.port ?? process.env.BUREAU_PORT ?? process.env.PORT ?? 8830
  )
  const launchCmd = flags["camofox-cmd"]
  const detach = flags.detach === "true" || flags.detach === ""
  const timeoutMs = Number(flags.timeout ?? 60) * 1000
  const pluginArgs = pluginSpecs(argv, {}).flatMap(s => ["--plugin", s])

  try {
    if (adapter !== "bureau-only") {
      const result = await ensureCamofox({
        port: camofoxPort,
        launchCmd,
        timeoutMs,
        log,
      })
      log(
        result.wasAlreadyRunning
          ? `camofox already running on :${camofoxPort}`
          : `camofox started on :${camofoxPort}`
      )
    }

    if (detach) {
      const child = spawn(process.execPath, [process.argv[1]!, "serve", ...pluginArgs], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          CAMOFOX_URL: `http://127.0.0.1:${camofoxPort}`,
          PORT: String(bureauPort),
        },
      })
      child.unref()
      log(
        `bureau serve spawned (pid ${child.pid ?? "unknown"}), waiting for health on :${bureauPort}…`
      )
      const health = await waitHealthy(
        `http://127.0.0.1:${bureauPort}/health`,
        timeoutMs
      )
      const toolCount =
        typeof health.tools === "number" ? ` — ${health.tools} tools` : ""
      log(`bureau serve healthy on :${bureauPort}${toolCount}`)
      return 0
    } else {
      process.env.CAMOFOX_URL = `http://127.0.0.1:${camofoxPort}`
      process.env.PORT = String(bureauPort)
      const { runServe } = await import("../serve.js")
      await runServe(pluginArgs, extraPlugins)
      return 0
    }
  } catch (err) {
    out(`${PREFIX} ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
