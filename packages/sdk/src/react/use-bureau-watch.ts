"use client"

/**
 * Live-watch consumer: subscribe to one Bureau tab's frame stream and keep a
 * bounded tail of the latest frames for a renderer to follow. The producer is
 * the Bureau server's `/watch/<tabId>` endpoint — a WebSocket of
 * `bureauFrameSchema`-shaped messages; this hook is its mirror on the client.
 *
 * Transport-injected like `useBureau`: the host hands a `connect` thunk that
 * opens the socket (a local `ws://127.0.0.1` for the packaged app, a tunnel
 * `wss://…/me/daemon/…` for a connected cloud), so the SDK carries no host URL
 * or auth scheme. Every message is validated against the wire schema before it
 * reaches the renderer — a malformed frame is dropped, never shown.
 *
 * Memory-bounded by design: a live session runs indefinitely, so only the last
 * `maxFrames` are retained (older frames evict off the front). The live tail is
 * what a watcher cares about; deep scrollback is the recording's job, not this.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { BureauFrame } from "../schemas.js"
import {
  STOP_SENTINEL,
  appendBounded,
  parseFrameMessage,
} from "../watch-frames.js"

export type WatchStatus = "idle" | "connecting" | "open" | "closed" | "error"

export interface UseBureauWatchOptions {
  /**
   * Opens the socket for the watched tab, or `null` to stay idle (no tab
   * selected yet). The host builds the URL so the SDK stays free of any host
   * URL or auth scheme; the hook owns the returned socket's lifecycle and
   * closes it on unmount or when `connect` changes.
   */
  connect: (() => WebSocket) | null
  /** Retained-frame cap; older frames drop off the front. Default 600
   *  (~2.5 min at the server's default 4fps). */
  maxFrames?: number
}

export interface UseBureauWatchResult {
  /** Retained frames, oldest → newest, capped at `maxFrames`. */
  frames: BureauFrame[]
  /** Total frames received since connect (monotonic; counts evicted frames). */
  received: number
  status: WatchStatus
  error: string | null
  /** End the stream early: sends the producer's stop sentinel, then closes. */
  stop: () => void
}

const DEFAULT_MAX_FRAMES = 600

export function useBureauWatch({
  connect,
  maxFrames = DEFAULT_MAX_FRAMES,
}: UseBureauWatchOptions): UseBureauWatchResult {
  const [frames, setFrames] = useState<BureauFrame[]>([])
  const [received, setReceived] = useState(0)
  const [status, setStatus] = useState<WatchStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const socketRef = useRef<WebSocket | null>(null)

  const stop = useCallback(() => {
    const ws = socketRef.current
    if (!ws) return
    try {
      if (ws.readyState === ws.OPEN) ws.send(STOP_SENTINEL)
      ws.close()
    } catch {
      /* already closing — nothing to release */
    }
  }, [])

  useEffect(() => {
    if (!connect) {
      setStatus("idle")
      return
    }
    // Fresh stream: drop any prior tail so the viewer never blends two sessions.
    setFrames([])
    setReceived(0)
    setError(null)
    setStatus("connecting")

    const ws = connect()
    socketRef.current = ws

    ws.onopen = () => setStatus("open")
    ws.onmessage = event => {
      const frame = parseFrameMessage(event.data)
      if (!frame) return // malformed or non-frame message — drop, never render
      setFrames(prev => appendBounded(prev, frame, maxFrames))
      setReceived(n => n + 1)
    }
    ws.onerror = () => {
      setError("watch stream error")
      setStatus("error")
    }
    ws.onclose = () => {
      setStatus(prev => (prev === "error" ? prev : "closed"))
    }

    return () => {
      try {
        if (ws.readyState === ws.OPEN) ws.send(STOP_SENTINEL)
        ws.close()
      } catch {
        /* socket already torn down */
      }
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      socketRef.current = null
    }
  }, [connect, maxFrames])

  return { frames, received, status, error, stop }
}
