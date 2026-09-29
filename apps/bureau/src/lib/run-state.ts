/**
 * The Bureau run-state file: `<bureau home>/bureau-run.json`, 0600. `serve`
 * writes it once it is listening and removes it on a clean shutdown; `stop`
 * reads it. Only a Bureau that wrote this file can be stopped by `bureau stop`.
 * Holds ports, pids and a message; never a secret.
 */

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

export interface RunState {
  version: 1
  pid: number
  port: number
  host: string
  browser: string
  browserInstanceId?: string
  browserPid?: number
  /** True when this Bureau launched the browser (false when it reused a running one). */
  browserOwned: boolean
  startedAt: string
  error?: string
}

export const runStatePath = (home: string): string => join(home, "bureau-run.json")

export async function writeRunState(home: string, state: RunState): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const path = runStatePath(home)
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

export async function readRunState(home: string): Promise<RunState | null> {
  let raw: string
  try {
    raw = await readFile(runStatePath(home), "utf8")
  } catch {
    return null
  }
  try {
    const v = JSON.parse(raw) as Partial<RunState>
    if (v.version !== 1 || typeof v.pid !== "number" || typeof v.port !== "number") return null
    return v as RunState
  } catch {
    return null
  }
}

export async function removeRunState(home: string): Promise<void> {
  await rm(runStatePath(home), { force: true })
}

/** True when `pid` names a live process (signal 0 probes without delivering). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}
