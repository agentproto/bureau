/**
 * Ensure the HEADLESS camofox serve instance (:9377) is up and healthy.
 * Idempotent — returns immediately if already running.
 *
 * Launch command resolution order:
 *   1. opts.launchCmd
 *   2. $CAMOFOX_SERVE_CMD
 *   3. macOS launchd: `launchctl start sh.bureau.camofox`
 * If none resolves → throws with explicit instructions (no silent magic).
 *
 * `pid` may be `undefined` — when camofox is started via launchctl, launch()
 * returns null (launchctl exits in ~50ms and is not the actual process).
 * Never use `pid` to kill camofox; use launchctl or SIGTERM on the port's
 * owning process instead.
 */

import { spawn } from "node:child_process"
import { platform } from "node:os"
import { ensureBrowserProcess } from "@agentproto/browser-process"
import {
  killProcessSignal,
  listProcessesViaPs,
  reapOrphanCamoufoxChildren,
  type KillProcess,
  type ListProcesses,
} from "./reap-orphans.js"

/**
 * The most recent camofox server pid THIS process spawned directly (not via
 * launchctl — see the file header on why launchctl's pid is never tracked).
 * Module-level: `bureau start`/`bureau serve` calls `ensureCamofox` from one
 * long-lived process, so a later call in the SAME run can tell "the backend I
 * spawned before is gone, reap its orphaned children" from "this is the
 * first launch, nothing to reap yet".
 */
let lastSpawnedPid: number | undefined

/**
 * The ONE shared launch-budget constant (from live runs): observed cold camofox relaunches took 47s and 80s, well past a
 * 30-60s budget. Used here as the default `ensureCamofox` timeout, by the
 * active-driver-pool's launch-coincident retry (`lib/backend-health.ts`), and
 * exported for a later kit supervisor (L2b) to reuse — one number, not three
 * places that can drift.
 */
export const LAUNCH_BUDGET_MS = 120_000

function resolveCmd(
  launchCmd: string | undefined
): { file: string; args: string[] } | null {
  if (launchCmd) return { file: "/bin/sh", args: ["-c", launchCmd] }
  const envCmd = process.env.CAMOFOX_SERVE_CMD
  if (envCmd) return { file: "/bin/sh", args: ["-c", envCmd] }
  if (platform() === "darwin")
    return { file: "launchctl", args: ["start", "sh.bureau.camofox"] }
  return null
}

export async function ensureCamofox(opts: {
  port?: number
  launchCmd?: string
  timeoutMs?: number
  log?: (s: string) => void
  /** Test seams for orphan reaping — production defaults to real `ps`/`kill`. */
  listProcesses?: ListProcesses
  killProcess?: KillProcess
  /** Disable the reap entirely (e.g. a platform with no `ps`); default false. */
  reapOrphans?: boolean
}): Promise<{ port: number; pid?: number; wasAlreadyRunning: boolean }> {
  const port = opts.port ?? 9377
  const timeoutMs = opts.timeoutMs ?? LAUNCH_BUDGET_MS
  const log = opts.log ?? (() => {})
  const reapOrphans = opts.reapOrphans ?? true
  const listProcesses = opts.listProcesses ?? listProcessesViaPs
  const killProcess = opts.killProcess ?? killProcessSignal
  const priorPid = lastSpawnedPid

  const result = await ensureBrowserProcess({
    kind: "camofox",
    healthUrl: `http://127.0.0.1:${port}/health`,
    launch() {
      const cmd = resolveCmd(opts.launchCmd)
      if (!cmd) {
        throw new Error(
          `camofox is not running on :${port} and no launch command is available. ` +
            `Set CAMOFOX_SERVE_CMD (e.g. CAMOFOX_SERVE_CMD="camoufox serve" bureau start) ` +
            `or pass opts.launchCmd.`
        )
      }
      log(`starting camofox: ${[cmd.file, ...cmd.args].join(" ")}`)
      if (cmd.file === "launchctl") {
        // launchctl is not the real process — spawn it for its side-effect
        // and return null so the caller never sees launchctl's short-lived PID.
        spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore" }).unref()
        return null
      }
      const child = spawn(cmd.file, cmd.args, {
        detached: true,
        stdio: "ignore",
      })
      child.unref()
      return child
    },
    timeoutMs,
    intervalMs: 1000,
    log,
  })

  if (result.wasAlreadyRunning) {
    log(`camofox already healthy on :${port}`)
  } else {
    log(`camofox healthy on :${port} (pid ${result.pid ?? "unknown"})`)
    // A fresh spawn (not launchctl — those have no trackable pid) that
    // follows a PRIOR spawn in this same process means the old server is
    // gone; reap any camoufox browser children it left orphaned (INPUTS item
    // 3). Skipped on the very first launch (nothing prior to reap) and when
    // this launch went through launchctl (no marker pid on either side).
    if (reapOrphans && priorPid != null) {
      reapOrphanCamoufoxChildren({
        deadManagedPids: new Set([priorPid]),
        listProcesses,
        killProcess,
        log,
      }).catch(err => log(`[bureau] orphan reap failed (non-fatal): ${String(err)}`))
    }
    if (result.pid != null) lastSpawnedPid = result.pid
  }

  return { port, pid: result.pid, wasAlreadyRunning: result.wasAlreadyRunning }
}
