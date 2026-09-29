/**
 * `--record` glue for commands that dispatch a tool over a `SessionResolver`.
 * The frame-grab recorder primitive lives in `@agentproto/bureau-core/recorder`
 * (shared with the MCP capability server); this module adds only the
 * resolver-coupled convenience the CLI needs — `attachRecording`, which can't
 * live in browser-core because `SessionResolver` sits above it in the stack.
 */

import type { SessionResolver } from "./ports.js"
import {
  startSessionRecording,
  canRecord,
  type RecordableSession,
  type SessionRecording,
} from "@agentproto/bureau-core/recorder"

export {
  startSessionRecording,
  canRecord,
  type RecordableSession,
  type SessionRecording,
}

/**
 * Wire `--record` for a command that dispatches a tool over a `SessionResolver`.
 * Resolves the target session ONCE and returns a resolver that hands the DRIVER
 * that same live instance — so there's a single camofox tab and a single
 * navigation (the driver's), with the recorder only screenshotting it. This is
 * what keeps recording from spinning up a second `openSession` that races the
 * driver or lands on an unintended page. `record` is the raw flag value: falsy =
 * off (returns the base resolver untouched), `"true"` = on with `defaultName`,
 * any other string = on with that path. `finish()` stops + assembles; call it in
 * both the success and failure paths.
 */
export async function attachRecording(
  base: SessionResolver,
  sessionId: string,
  record: string | undefined,
  opts: { defaultName: string; fps?: number; log: (s: string) => void }
): Promise<{ sessions: SessionResolver; finish: () => Promise<void> }> {
  const noop = { sessions: base, finish: async () => {} }
  if (!record) return noop
  const outPath = record === "true" ? opts.defaultName : record
  let live: RecordableSession & Awaited<ReturnType<SessionResolver["resolve"]>>
  try {
    live = await base.resolve(sessionId)
  } catch (e) {
    opts.log(
      `  ⚠ --record: couldn't resolve session (${e instanceof Error ? e.message : String(e)}) — running without video`
    )
    return noop
  }
  const sessions: SessionResolver = {
    resolve: ref =>
      ref === sessionId ? Promise.resolve(live) : base.resolve(ref),
  }
  if (!canRecord(live)) {
    opts.log(
      `  ⚠ --record: session "${sessionId}" backend can't be screenshotted — running without video`
    )
    return { sessions, finish: async () => {} }
  }
  const rec = startSessionRecording(live, { out: outPath, fps: opts.fps ?? 3 })
  opts.log(`● recording → ${outPath}`)
  return {
    sessions,
    finish: async () => {
      const saved = await rec.stop()
      opts.log(
        saved
          ? `■ recording saved → ${saved}`
          : `  ⚠ --record: no frames captured`
      )
    },
  }
}
