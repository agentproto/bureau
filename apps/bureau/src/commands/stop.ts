/**
 * `bureau stop` — stop the Bureau this user started with `bureau start`/`serve`.
 *
 * It acts only on a Bureau that wrote the run-state file, and only after that
 * pid answers `/health` on its recorded port, so a recycled pid or a Bureau
 * someone else runs is never signalled. Bureau's own shutdown then stops the
 * browser it launched; a browser it merely found already running is left alone.
 */

import { parseArgs, out } from "../lib/args.js"
import { bureauHome } from "../lib/pairing.js"
import { pidAlive, readRunState, removeRunState } from "../lib/run-state.js"

const USAGE = `bureau stop: stop the Bureau (and the browser it launched) that bureau start began

  bureau stop [--timeout N]

  Only a Bureau with a state file in the Bureau home is stopped. A browser that was
  already running when Bureau started is left running.`

export interface StopDeps {
  home?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  isAlive?: (pid: number) => boolean
  kill?: (pid: number, signal: NodeJS.Signals) => void
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

const PREFIX = "[bureau stop]"

export async function runStop(argv: string[], deps: StopDeps = {}): Promise<number> {
  const say = deps.log ?? out
  const log = (s: string): void => say(`${PREFIX} ${s}`)
  const { flags } = parseArgs(argv)
  if (flags["help"]) {
    say(USAGE)
    return 0
  }
  const home = deps.home ?? bureauHome(deps.env ?? process.env)
  const isAlive = deps.isAlive ?? pidAlive
  const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals): void => void process.kill(pid, sig))
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise(r => setTimeout(r, ms)))
  const doFetch = deps.fetch ?? fetch
  const waitMs = Number(flags["timeout"] ?? 15) * 1000

  const state = await readRunState(home)
  if (!state) {
    log("nothing started by bureau is running")
    return 0
  }
  if (!isAlive(state.pid)) {
    await removeRunState(home)
    log(`bureau (pid ${state.pid}) is not running; removed the stale state file`)
    return 0
  }

  let answers = false
  try {
    const r = await doFetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(3000) })
    answers = r.ok
  } catch {
    answers = false
  }
  if (!answers) {
    log(`pid ${state.pid} is alive but nothing answers on :${state.port}; not signalling it. Remove ${home}/bureau-run.json if it is stale.`)
    return 1
  }

  kill(state.pid, "SIGTERM")
  const deadline = Date.now() + waitMs
  while (isAlive(state.pid) && Date.now() < deadline) await sleep(100)
  if (isAlive(state.pid)) {
    log(`bureau (pid ${state.pid}) did not exit within ${waitMs / 1000}s`)
    return 1
  }
  await removeRunState(home)
  log(`stopped bureau (pid ${state.pid}, port ${state.port})`)
  log(
    state.browserOwned
      ? `browser ${state.browser} was started by bureau and has been stopped`
      : `browser ${state.browser} was already running when bureau started, so it was left running`
  )
  return 0
}
