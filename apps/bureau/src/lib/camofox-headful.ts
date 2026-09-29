/**
 * Ensure a HEADFUL camofox is serving — the visible Firefox window an
 * interactive login needs. The persistent camofox (:9377, launchd) is HEADLESS
 * and serves every automated run; a login can't happen there (no window), so
 * this brings up an on-demand headful instance (default :9378) and the headless
 * runs reuse the session it establishes (both instances share camofox's
 * `sessions/<sessionKey>.json` storage on disk).
 *
 * Idempotent: returns the base if one is already healthy, else launches it and
 * waits for health. Launch command resolution, in order:
 *   1. $CAMOFOX_HEADFUL_CMD  — a packaged Bureau points this at its bundled
 *      camofox launcher (receives the port as $CAMOFOX_HEADFUL_PORT).
 *   2. scripts/camofox-headful.sh, located by walking up from cwd AND from this
 *      module's own dir (so it resolves no matter where Bureau is invoked from —
 *      the script ships under projects/browser/scripts).
 * If neither resolves, throws with the exact command to run by hand.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function healthy(base: string): Promise<boolean> {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 3000)
    const r = await fetch(`${base}/health`, { signal: ac.signal })
    clearTimeout(t)
    return r.ok
  } catch {
    return false
  }
}

/**
 * Read `activeTabs` from camofox's `/health` (live shape:
 * `{ok, engine, browserConnected, browserRunning, activeTabs, activeSessions,
 * consecutiveFailures}`). Returns `null` when the endpoint is unreachable or
 * the field is absent, so callers can treat "unknown" as "don't intervene".
 */
async function activeTabs(base: string): Promise<number | null> {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 3000)
    const r = await fetch(`${base}/health`, { signal: ac.signal })
    clearTimeout(t)
    if (!r.ok) return null
    const body = (await r.json()) as { activeTabs?: unknown }
    return typeof body.activeTabs === "number" ? body.activeTabs : null
  } catch {
    return null
  }
}

/**
 * Force a tab open on a healthy-but-tabless camofox. The headful instance can
 * report `activeTabs: 0` while the process is up (the window's tab was closed /
 * lost); every browser op then fails or returns stale. Create a tab under the
 * control context and navigate it to about:blank so the instance has something
 * live. Best-effort — swallow errors, the caller re-checks activeTabs.
 *
 * Scope: this runs only at headful-instance bring-up (the `bureau session`
 * login/reauth CLI flow), NOT per browser_act call — so the control user
 * ("main") and the instance-wide activeTabs count are the right signals here.
 * Per-session tab loss in the act pool is handled by pool eviction, not here.
 */
async function forceOpenTab(base: string): Promise<void> {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 5000)
    const r = await fetch(`${base}/tabs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "main", sessionKey: "main" }),
      signal: ac.signal,
    })
    clearTimeout(t)
    if (!r.ok) return
    const body = (await r.json()) as { tabId?: string }
    if (!body.tabId) return
    const ac2 = new AbortController()
    const t2 = setTimeout(() => ac2.abort(), 5000)
    await fetch(`${base}/tabs/${body.tabId}/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "main", url: "about:blank" }),
      signal: ac2.signal,
    })
    clearTimeout(t2)
  } catch {
    // best-effort — caller re-checks activeTabs and decides
  }
}

/**
 * If camofox is up but reports zero open tabs, force one open and wait for
 * `activeTabs >= 1`. No-op when tabs are already present or the count can't be
 * read (unknown ≠ zero — never intervene on an ambiguous health response).
 */
async function ensureTabPresent(base: string): Promise<void> {
  const tabs = await activeTabs(base)
  if (tabs === null || tabs >= 1) return
  await forceOpenTab(base)
  for (let i = 0; i < 5; i++) {
    const n = await activeTabs(base)
    if (n === null || n >= 1) return
    await sleep(500)
  }
}

/** Walk up from `start` for `scripts/camofox-headful.sh`. */
function findRepoScript(start: string): string | null {
  let dir = start
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "scripts", "camofox-headful.sh")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function resolveLaunch(port: number): { file: string; args: string[] } | null {
  const cmd = process.env.CAMOFOX_HEADFUL_CMD
  if (cmd) return { file: "/bin/sh", args: ["-c", cmd] }
  // cwd first (dev runs from the repo), then this module's location (so an
  // invocation from any cwd still finds projects/browser/scripts/…).
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const script = findRepoScript(process.cwd()) ?? findRepoScript(moduleDir)
  if (script) return { file: "/bin/bash", args: [script, String(port)] }
  return null
}

export async function ensureHeadfulCamofox(
  opts: { base?: string; port?: number } = {}
): Promise<string> {
  const port = opts.port ?? 9378
  const base = opts.base ?? `http://127.0.0.1:${port}`
  if (await healthy(base)) {
    // Up, but a headful window can lose its tab; make sure one is open before
    // handing the base back to the pool.
    await ensureTabPresent(base)
    return base
  }

  const launch = resolveLaunch(port)
  if (!launch)
    throw new Error(
      `no headful camofox at ${base}, and no way to start one — run ` +
        `\`scripts/camofox-headful.sh ${port}\` by hand, or set CAMOFOX_HEADFUL_CMD`
    )

  // Detached so the login window outlives this CLI invocation.
  const child = spawn(launch.file, launch.args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CAMOFOX_HEADFUL_PORT: String(port) },
  })
  child.unref()

  for (let i = 0; i < 30; i++) {
    await sleep(2000)
    if (await healthy(base)) {
      // A freshly launched camofox reports activeTabs: 0 until a tab is opened;
      // force one so the pool doesn't adopt a tabless context.
      await ensureTabPresent(base)
      return base
    }
  }
  throw new Error(
    `headful camofox on :${port} did not become healthy — see /tmp/camofox-headful-${port}.log`
  )
}
