/**
 * Live watch — stream one open tab's screen to a connected client over a
 * WebSocket. A connected operator (local panel, or a cloud over the
 * daemon tunnel) opens `/watch/<tabId>` and receives a steady stream of
 * `ScreencastFrame`-shaped messages until it disconnects.
 *
 * Metadata-and-pixels only: a frame is base64 image bytes + its position in the
 * stream, never any cookie or credential. Same guarantee as the rest of Bureau.
 *
 * Two producer shapes exist behind one `FrameSource` seam: a stealth (camofox)
 * tab has no CDP screencast, so its source POLLS screenshots; a CDP-backed tab
 * would drain `Page.startScreencast`. The connection handler doesn't care which
 * — it pumps whatever the source yields. This server drives camofox, so the
 * screenshot-poll source is the one wired; a CDP source drops in alongside it.
 */

import type { Server as HttpServer } from "node:http"
import { WebSocketServer, type WebSocket } from "ws"
import type { ScreencastFrame } from "@agentproto/bureau-core/driver"

/** The slice of a browser client a screenshot source needs — kept structural so
 *  the camofox REST client satisfies it without this module importing it. */
interface ScreenshotPort {
  getScreenshot(
    tabId: string,
    options?: { format?: string; quality?: number }
  ): Promise<Buffer>
}

/** A producer of live frames for one tab. `grab` returns the next frame, or
 *  `null` when the tab is gone (the pump stops and closes the socket). */
interface FrameSource {
  grab(index: number): Promise<ScreencastFrame | null>
  stop(): Promise<void>
}

interface WatchOptions {
  format: "jpeg" | "png"
  quality: number
  fps: number
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/** Screenshot-poll source for a stealth (camofox) tab: one screenshot per tick,
 *  single-flight (the pump awaits each grab before scheduling the next). */
function screenshotPollSource(
  client: ScreenshotPort,
  tabId: string,
  opts: WatchOptions
): FrameSource {
  return {
    async grab(index) {
      const bytes = await client.getScreenshot(tabId, {
        format: opts.format,
        quality: opts.quality,
      })
      // Camofox returns PNG regardless of the requested format; declare the REAL
      // format (sniff the magic bytes) so the viewer's `data:image/<fmt>` URL
      // decodes — a jpeg-labeled PNG fails on strict decoders, leaving a blank
      // frame even though bytes arrived.
      const format =
        bytes[0] === 0x89 ? "png" : bytes[0] === 0xff ? "jpeg" : opts.format
      return {
        data: bytes.toString("base64"),
        format,
        timestampMs: Date.now(),
        index,
      }
    },
    async stop() {
      /* poll source holds nothing to release */
    },
  }
}

/** Pump frames from a source to a socket at a target cadence until either side
 *  ends the stream. A transient grab error skips one frame rather than killing
 *  the watch — a single camofox blip shouldn't tear down a live session. */
async function pump(
  ws: WebSocket,
  source: FrameSource,
  fps: number
): Promise<void> {
  const intervalMs = Math.max(Math.round(1000 / Math.max(fps, 1)), 50)
  let stopped = false
  let index = 0

  const end = () => {
    stopped = true
  }
  ws.on("close", end)
  ws.on("error", end)
  // The only client→producer message we honour is a stop request; anything
  // else is ignored (the channel is one-way frames otherwise).
  ws.on("message", raw => {
    if (String(raw).includes("stop")) {
      end()
      if (ws.readyState === ws.OPEN) ws.close()
    }
  })

  try {
    while (!stopped && ws.readyState === ws.OPEN) {
      const started = Date.now()
      try {
        const frame = await source.grab(index++)
        if (!frame) break
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
      } catch {
        // Transient producer error — drop this frame, keep the stream alive.
      }
      const elapsed = Date.now() - started
      if (elapsed < intervalMs) await sleep(intervalMs - elapsed)
    }
  } finally {
    await source.stop().catch(() => {})
    if (ws.readyState === ws.OPEN) ws.close()
  }
}

/**
 * Attach the watch endpoint to the running HTTP server. Hijacks WS upgrades on
 * `/watch/<tabId>`; non-matching upgrades are dropped so the rest of the server
 * (MCP over POST) is untouched. Query params tune the stream:
 *   ?format=jpeg|png  ?quality=1..100  ?fps=1..N
 *
 * A camofox tab lives under its SESSION's userId context, not the control
 * "main" one, so the host injects `resolveOwner` (tabId → owning userId) and
 * `screenshotsFor` (a screenshot client for that userId). Screenshotting a
 * session tab under "main" 404s it — the stream would connect but never produce
 * a frame.
 */
export function attachWatch(
  httpServer: HttpServer,
  deps: {
    resolveOwner: (tabId: string) => Promise<string | null>
    screenshotsFor: (userId: string) => ScreenshotPort
  }
): void {
  const wss = new WebSocketServer({ noServer: true })

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost")
    const match = url.pathname.match(/^\/watch\/(.+)$/)
    if (!match) {
      socket.destroy()
      return
    }
    const tabId = decodeURIComponent(match[1])
    const opts: WatchOptions = {
      format: url.searchParams.get("format") === "png" ? "png" : "jpeg",
      quality: clampInt(url.searchParams.get("quality"), 60, 1, 100),
      fps: clampInt(url.searchParams.get("fps"), 4, 1, 30),
    }
    wss.handleUpgrade(req, socket, head, ws => {
      void (async () => {
        // Resolve which session (camofox userId) owns this tab, so the poll
        // targets the right context — else camofox 404s every screenshot.
        const userId = await deps.resolveOwner(tabId).catch(() => null)
        if (!userId) {
          if (ws.readyState === ws.OPEN) ws.close()
          return
        }
        const source = screenshotPollSource(
          deps.screenshotsFor(userId),
          tabId,
          opts
        )
        await pump(ws, source, opts.fps)
      })()
    })
  })
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  const n = raw === null ? NaN : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
