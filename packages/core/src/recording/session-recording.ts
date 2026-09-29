/**
 * Session screen-recorder — captures what a live session's tab shows while an
 * operation runs and assembles it into a video. The recorder only needs a
 * `screenshot()` capability (any camofox/CDP-backed session), so it records the
 * very session a scrape drives — an authed search ends up on video, not an
 * isolated unauthenticated tab.
 *
 * Mechanism: poll `session.screenshot()` on a timer into PNG frames, then
 * ffmpeg-assemble them at stop(). Frame capture is cross-platform and needs no
 * X display (the screenshot endpoint works headless), so it records on
 * macOS/dev where x11grab can't. A single-flight guard drops ticks while a
 * screenshot is still in flight rather than queueing them.
 *
 * Node-only (spawns ffmpeg, writes temp frames) — exposed as the
 * `@agentproto/bureau-core/recorder` subpath, NOT from the package root, which
 * stays import-pure for browser/bundler consumers.
 */

import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

/** The one capability a recorder needs: show me the current view. */
export interface RecordableSession {
  screenshot?(opts?: {
    format?: "png" | "jpeg"
    quality?: number
  }): Promise<{ imageBase64: string; mimeType: string }>
}

export interface SessionRecording {
  /** Stop capturing and assemble the video. Resolves to its path, or undefined
   *  if no frame was captured (idempotent — repeat calls return the same path). */
  stop(): Promise<string | undefined>
}

/** Whether a session can be recorded (camofox/CDP yes, eval-only no). */
export function canRecord(session: RecordableSession): boolean {
  return typeof session.screenshot === "function"
}

/**
 * Begin recording `session`. Throws if the backend can't screenshot — callers
 * gate on {@link canRecord} and warn rather than letting the op proceed
 * silently unrecorded. Capture starts immediately; drive the session, then
 * `await stop()`.
 */
export function startSessionRecording(
  session: RecordableSession,
  opts: { out: string; fps?: number }
): SessionRecording {
  if (!session.screenshot) {
    throw new Error(
      "this session backend can't be recorded (no screenshot capability)"
    )
  }
  const shot = session.screenshot.bind(session)
  const fps = opts.fps && opts.fps > 0 ? opts.fps : 4
  const framesDir = mkdtempSync(join(tmpdir(), "bureau-rec-"))
  mkdirSync(dirname(opts.out), { recursive: true })

  let n = 0
  let busy = false
  let stopped = false
  const tick = async (): Promise<void> => {
    if (busy || stopped) return
    busy = true
    try {
      const { imageBase64 } = await shot({ format: "png" })
      if (!stopped) {
        const name = `frame-${String(n).padStart(6, "0")}.png`
        writeFileSync(join(framesDir, name), Buffer.from(imageBase64, "base64"))
        n++
      }
    } catch {
      // tab mid-navigation / transient — skip this frame.
    } finally {
      busy = false
    }
  }
  const timer = setInterval(tick, Math.max(50, Math.round(1000 / fps)))
  timer.unref?.()

  let stopPromise: Promise<string | undefined> | undefined
  return {
    stop() {
      if (stopPromise) return stopPromise
      stopped = true
      clearInterval(timer)
      stopPromise = (async () => {
        for (let i = 0; busy && i < 20; i++)
          await new Promise(r => setTimeout(r, 50))
        if (n === 0) {
          rmSync(framesDir, { recursive: true, force: true })
          return undefined
        }
        // Codec follows the output extension: .mp4 → h264 (plays in QuickTime and
        // every browser), anything else → VP8/webm (smaller, but no QuickTime).
        const codec = opts.out.toLowerCase().endsWith(".mp4")
          ? ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
          : ["-c:v", "libvpx", "-b:v", "1M", "-pix_fmt", "yuv420p"]
        // Force even dimensions — the real browser window can be an odd height
        // (e.g. 1680x989) and yuv420p/h264 demands even W and H, else the encode
        // fails and leaves a headerless file. Round down a pixel rather than pad.
        const evenDims = ["-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2"]
        await new Promise<void>(resolve => {
          const proc = spawn(
            "ffmpeg",
            [
              "-loglevel",
              "error",
              "-framerate",
              String(fps),
              "-i",
              join(framesDir, "frame-%06d.png"),
              ...evenDims,
              ...codec,
              "-y",
              opts.out,
            ],
            { stdio: ["ignore", "ignore", "inherit"] }
          )
          proc.on("exit", () => resolve())
          proc.on("error", () => resolve())
        })
        rmSync(framesDir, { recursive: true, force: true })
        return opts.out
      })()
      return stopPromise
    },
  }
}
