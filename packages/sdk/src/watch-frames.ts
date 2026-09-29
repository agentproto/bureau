/**
 * Pure watch-stream helpers — the framework-free core of live watch, shared by
 * the React hook (`useBureauWatch`) and any non-React consumer (a packaged-app
 * node watcher draining the same socket). No React, no DOM, no I/O.
 *
 * The wire is one-way frames: the producer streams `bureauFrameSchema`-shaped
 * JSON text and honours exactly one client message — anything containing
 * "stop" ends its pump.
 */

import { bureauFrameSchema, type BureauFrame } from "./schemas.js"

/** The one client→producer message the watch server acts on: it ends its pump
 *  on any message containing "stop". */
export const STOP_SENTINEL = JSON.stringify({ stop: true })

/**
 * Validate one raw watch message into a frame, or `null` to drop it. The
 * producer streams text frames, so non-string payloads (a stray Blob/binary)
 * are rejected; malformed JSON and shape mismatches are rejected too. A bad
 * frame never reaches the renderer — it's dropped, not thrown.
 */
export function parseFrameMessage(data: unknown): BureauFrame | null {
  if (typeof data !== "string") return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  const result = bureauFrameSchema.safeParse(parsed)
  return result.success ? result.data : null
}

/**
 * Append a frame to a retained buffer, capped at `cap` by evicting from the
 * front. The live tail is what a watcher follows; deep scrollback is the
 * recording's job, so an unbounded live session never grows without limit.
 * Returns a new array (never mutates the input).
 */
export function appendBounded(
  buffer: readonly BureauFrame[],
  frame: BureauFrame,
  cap: number
): BureauFrame[] {
  const limit = Math.max(1, cap)
  if (buffer.length >= limit) {
    return [...buffer.slice(buffer.length - limit + 1), frame]
  }
  return [...buffer, frame]
}
