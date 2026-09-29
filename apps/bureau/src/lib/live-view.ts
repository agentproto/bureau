/**
 * Read-only live view: `GET /live/<session>` streams screenshots of a session's
 * ACTIVE driver so a UI-less sandbox can be watched.
 *
 * Transport: MJPEG (`multipart/x-mixed-replace`). It shows in a plain `<img>`
 * tag with no client script, sends raw image bytes (SSE would base64 every
 * frame, +33 percent), and is ordinary chunked HTTP, which the pairing tunnel
 * already forwards. Each part carries its own content type, so camofox's PNG
 * frames need no transcode. The trade-off: no per-frame metadata channel, which
 * a watcher does not need.
 *
 * The server hook (`createBureauHttpServer`) has already done the method check
 * (405 for everything but GET), the Host check and pairing `authorize` (401).
 * This module adds the per-device grant check (403), the lookup of an already
 * open session (404, it never opens one), a floor on the frame interval, a cap
 * on streams per device and on stream length. It accepts no input: the request
 * body is never read and nothing here reaches a driver verb but `screenshot`.
 * Access is re-checked before every frame, so a revoked grant ends the stream.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import type { DeviceIdentity } from "./device-context.js"

export interface LiveFrame {
  bytes: Uint8Array
  mime: string
}

/** Grabs the next frame of one open session; null when the session is gone. */
export type LiveFrameGrabber = () => Promise<LiveFrame | null>

export interface LiveViewOptions {
  /** The frame grabber of an ALREADY open session, or undefined when it is not open. Must not open one. */
  frames: (session: string) => Promise<LiveFrameGrabber | undefined>
  /** May this device watch this session? Called before the stream and before every frame. */
  mayView: (device: DeviceIdentity | undefined, session: string) => boolean
  /** Target time between frames. Default 1000 ms. */
  intervalMs?: number
  /** Floor for the interval, whatever was asked. Default 250 ms. */
  minIntervalMs?: number
  /** Most concurrent streams per device. Default 3. */
  maxStreamsPerDevice?: number
  /** A stream ends after this long. Default 10 minutes. */
  maxStreamMs?: number
  log?: (line: string) => void
}

export type LiveViewHandler = (req: IncomingMessage, res: ServerResponse, session: string, device: DeviceIdentity | undefined) => Promise<void>

export const LIVE_BOUNDARY = "bureau-frame"
const ANONYMOUS = "anonymous"
const MAX_FAILED_GRABS = 3

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function reply(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify({ error }))
}

export function createLiveView(opts: LiveViewOptions): LiveViewHandler {
  const minInterval = Math.max(1, opts.minIntervalMs ?? 250)
  const interval = Math.max(minInterval, opts.intervalMs ?? 1000)
  const maxStreams = opts.maxStreamsPerDevice ?? 3
  const maxMs = opts.maxStreamMs ?? 10 * 60_000
  const log = opts.log ?? ((): void => {})
  const active = new Map<string, number>()

  return async (_req, res, session, device) => {
    // A device with no grant for this session, or a session that is not open,
    // gets a fixed short answer: no detail on which it was.
    if (!opts.mayView(device, session)) return reply(res, 403, "forbidden")
    const owner = device?.fingerprint ?? ANONYMOUS
    if ((active.get(owner) ?? 0) >= maxStreams) return reply(res, 429, "too many streams")
    const grab = await opts.frames(session).catch(() => undefined)
    if (!grab) return reply(res, 404, "not found")

    active.set(owner, (active.get(owner) ?? 0) + 1)
    let open = true
    const stop = (): void => {
      open = false
    }
    res.on("close", stop)
    res.writeHead(200, {
      "content-type": `multipart/x-mixed-replace; boundary=${LIVE_BOUNDARY}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    })
    log(`[live] stream opened for session ${session.slice(0, 64)}`)
    const deadline = Date.now() + maxMs
    let failed = 0
    try {
      while (open && Date.now() < deadline) {
        if (!opts.mayView(device, session)) break
        const started = Date.now()
        let frame: LiveFrame | null = null
        try {
          frame = await grab()
        } catch {
          failed += 1
          if (failed >= MAX_FAILED_GRABS) break
        }
        if (frame === null && failed === 0) break
        if (frame !== null && open) {
          failed = 0
          const head = `--${LIVE_BOUNDARY}\r\ncontent-type: ${frame.mime}\r\ncontent-length: ${frame.bytes.length}\r\n\r\n`
          res.write(head)
          res.write(frame.bytes)
          res.write("\r\n")
        }
        const wait = interval - (Date.now() - started)
        if (wait > 0) await sleep(wait)
      }
    } finally {
      res.off("close", stop)
      const left = (active.get(owner) ?? 1) - 1
      if (left <= 0) active.delete(owner)
      else active.set(owner, left)
      if (!res.writableEnded) res.end()
      log("[live] stream closed")
    }
  }
}
