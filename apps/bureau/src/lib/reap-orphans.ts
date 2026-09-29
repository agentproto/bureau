/**
 * Reap orphan camoufox children left behind when Bureau (re)starts the
 * camofox backend it manages ("two orphan
 * camoufox children" observed after a `newcontext_timeout` restart loop —
 * the camofox REST server died/restarted without reaping the browser
 * process(es) it had spawned, which then got reparented to init).
 *
 * Deliberately scoped: NEVER a global `pkill camoufox`, which would kill
 * camoufox windows other tools or a human own on the same machine. A camoufox
 * process only counts as an orphan this reaper may touch when EITHER:
 *   - its ppid is 1 (reparented to init — its real parent died without
 *     reaping it), or
 *   - its ppid is a pid this caller explicitly marks "dead" — a PREVIOUS
 *     camofox server process THIS Bureau itself spawned (via
 *     `ensure-camofox.ts`) and which is no longer running.
 * A camoufox process whose ppid is the CURRENT, still-alive managed server is
 * never touched — that's a legitimate, in-use browser child. The process
 * lister/killer are injected so this is fully testable without touching the
 * real process table.
 */

/** One row of a process listing — the columns `ps -eo pid,ppid,comm` gives. */
export interface ProcessRow {
  pid: number
  ppid: number
  comm: string
}

/** Injected process lister — production reads `ps`; tests pass a fixture. */
export type ListProcesses = () => Promise<ProcessRow[]>

/** Injected killer — production sends a real signal; tests record calls. */
export type KillProcess = (pid: number, signal?: NodeJS.Signals) => void

/** Matches the camoufox browser binary's `comm` — substring, case-insensitive:
 *  real camoufox processes carry a version/arch-qualified name on some
 *  platforms, and nothing else plausible on this host's process table is
 *  named "camoufox". */
const CAMOUFOX_COMM_RE = /camoufox/i

/**
 * Which rows count as orphans: camoufox-comm processes reparented to init
 * (`ppid === 1`), or parented by a pid the caller marks dead. Pure function —
 * the actual `kill()` side effect lives in {@link reapOrphanCamoufoxChildren}.
 */
export function findOrphanCamoufoxChildren(
  rows: ProcessRow[],
  opts: { deadManagedPids?: ReadonlySet<number> } = {}
): ProcessRow[] {
  const dead = opts.deadManagedPids ?? new Set<number>()
  return rows.filter(
    row => CAMOUFOX_COMM_RE.test(row.comm) && (row.ppid === 1 || dead.has(row.ppid))
  )
}

/**
 * Reap orphan camoufox children — called when `ensure-camofox.ts` detects it
 * just spawned a FRESH camofox server (the previous one, if any, is now
 * `deadManagedPids`). Returns the pids it sent a signal to, for logging.
 */
export async function reapOrphanCamoufoxChildren(opts: {
  deadManagedPids?: ReadonlySet<number>
  listProcesses: ListProcesses
  killProcess: KillProcess
  log?: (s: string) => void
}): Promise<number[]> {
  const log = opts.log ?? (() => {})
  const rows = await opts.listProcesses()
  const orphans = findOrphanCamoufoxChildren(rows, {
    deadManagedPids: opts.deadManagedPids,
  })
  for (const row of orphans) {
    log(
      `[bureau] reaping orphan camoufox child pid ${row.pid} (ppid ${row.ppid}, comm ${row.comm})`
    )
    opts.killProcess(row.pid, "SIGTERM")
  }
  return orphans.map(r => r.pid)
}

/** Production process lister: `ps -Ao pid,ppid,comm` (BSD/macOS `ps` — Bureau
 *  only ever runs the reaper on darwin today, matching `ensure-camofox.ts`'s
 *  launchd path). Parsing is whitespace-split on the first two columns only,
 *  so a `comm` containing spaces (a full command line on some `ps` builds)
 *  still comes through intact as the remainder. */
export async function listProcessesViaPs(): Promise<ProcessRow[]> {
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const exec = promisify(execFile)
  const { stdout } = await exec("ps", ["-Ao", "pid=,ppid=,comm="])
  return stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) return null
      return { pid: Number(m[1]), ppid: Number(m[2]), comm: m[3] }
    })
    .filter((r): r is ProcessRow => r != null)
}

/** Production killer — a thin `process.kill` wrapper so the reap call site
 *  never touches the global directly (keeps it swappable/testable). */
export function killProcessSignal(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone — fine */
  }
}
