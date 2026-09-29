/**
 * Capability mixins for BrowserDriver.
 *
 * The base `BrowserDriver` (types.ts) covers what every backend can do. Richer
 * capabilities — screencast, native video, AI actions — are OPTIONAL mixins a
 * driver implements only when its `capabilities` flag is true. Callers narrow
 * with the type guards here instead of switching on `kind`, so new backends
 * drop in without touching call sites.
 */

import type { BrowserDriver } from "./types.js"
import type { CookieJson } from "../session/types.js"

// ---------- Cookie export / import (session bridging) ----------

/**
 * Read + write the live cookie jar. The seam that lets one driver's session
 * (e.g. the user's logged-in Chrome via the extension/tunneled backend) be
 * bridged into another (e.g. a stealth camofox capture) — "browse-as-the-user"
 * across engines. CDP backends back this with Network.getAllCookies /
 * Network.setCookies; the camofox service with its cookie endpoints.
 */
export interface SupportsCookies {
  /** Export cookies, optionally filtered to a domain (suffix match) or url. */
  getCookies(opts?: { domain?: string; url?: string }): Promise<CookieJson[]>
  /** Import cookies into the live jar. Returns how many were accepted. */
  setCookies(cookies: readonly CookieJson[]): Promise<{ injected: number }>
}

// ---------- Screencast (live CDP frame stream) ----------

export interface ScreencastFrame {
  /** Base64-encoded image bytes. */
  data: string
  format: "jpeg" | "png"
  /** ms epoch when the frame was captured. */
  timestampMs: number
  /** Monotonic index within the screencast session. */
  index: number
}

export interface SupportsScreencast {
  startScreencast(opts?: {
    format?: "jpeg" | "png"
    quality?: number
    everyNthFrame?: number
  }): Promise<void>
  stopScreencast(): Promise<{ frameCount: number }>
  getScreencastFrames(opts?: {
    offset?: number
    limit?: number
  }): Promise<{ frames: ScreencastFrame[]; totalFrames: number }>
}

// ---------- Native video recording ----------

export interface RecordedVideo {
  /** Base64-encoded video bytes. */
  base64: string
  mimeType: string
}

export interface SupportsRecording {
  /** Fetch the recorded video. Call BEFORE close() — the backend finalizes on context close. */
  getRecordedVideo(): Promise<RecordedVideo>
}

// ---------- High-level AI actions (Stagehand-style) ----------

export interface ActResult {
  success: boolean
  action?: string
}
export interface ObserveResult {
  selector: string
  description?: string
}
export interface AiExtractResult<T = unknown> {
  data: T
}
export interface AgentRunResult {
  success: boolean
  message?: string
  steps?: number
}

export interface SupportsAiActions {
  act(instruction: string): Promise<ActResult>
  observe(instruction?: string): Promise<ObserveResult[]>
  extract<T = unknown>(
    instruction: string,
    schema: unknown
  ): Promise<AiExtractResult<T>>
  agent(
    instruction: string,
    config?: Record<string, unknown>
  ): Promise<AgentRunResult>
}

// ---------- Type guards (gate on capability flag + method presence) ----------

export function supportsScreencast(
  d: BrowserDriver
): d is BrowserDriver & SupportsScreencast {
  return (
    d.capabilities.canScreencast &&
    typeof (d as Partial<SupportsScreencast>).startScreencast === "function"
  )
}

export function supportsRecording(
  d: BrowserDriver
): d is BrowserDriver & SupportsRecording {
  return (
    d.capabilities.canRecordVideo &&
    typeof (d as Partial<SupportsRecording>).getRecordedVideo === "function"
  )
}

export function supportsAiActions(
  d: BrowserDriver
): d is BrowserDriver & SupportsAiActions {
  return (
    d.capabilities.canAiActions &&
    typeof (d as Partial<SupportsAiActions>).act === "function"
  )
}

export function supportsCookies(
  d: BrowserDriver
): d is BrowserDriver & SupportsCookies {
  return (
    d.capabilities.canCookies === true &&
    typeof (d as Partial<SupportsCookies>).getCookies === "function" &&
    typeof (d as Partial<SupportsCookies>).setCookies === "function"
  )
}
