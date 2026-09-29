/**
 * Types for browser-recording domain.
 */

import { z } from "zod"

/** Capture strategy — open enum so new strategies need no migration. */
export const BROWSER_RECORDING_KINDS = [
  "screenshots-mp4",
  "rrweb",
  "webm-capture",
  "har",
] as const
export type BrowserRecordingKind = (typeof BROWSER_RECORDING_KINDS)[number]

/** Recording lifecycle. */
export const BROWSER_RECORDING_STATUSES = [
  "recording",
  "processing",
  "ready",
  "failed",
  "expired",
] as const
export type BrowserRecordingStatus = (typeof BROWSER_RECORDING_STATUSES)[number]

/** Event types a frame can correspond to. Matches the browser tool's action set. */
export const FRAME_EVENTS = [
  "navigate",
  "click",
  "type",
  "scroll",
  "submit",
  "screenshot",
  "wait",
  "scan",
  "act",
  "extract",
  "observe",
  "scrape",
  "execute",
] as const
export type FrameEvent = (typeof FRAME_EVENTS)[number]

/** One captured frame. Stored inside metadata.frameRefs for screenshots-mp4. */
export const frameRefSchema = z.object({
  /** Milliseconds since recording start. */
  t: z.number().int().nonnegative(),
  event: z.enum(FRAME_EVENTS),
  /** Storage path of the uploaded screenshot JPEG. */
  storagePath: z.string(),
  /** Optional context — URL after navigate, selector after click, etc. */
  url: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
})
export type FrameRef = z.infer<typeof frameRefSchema>

/** The JSONB metadata for a `screenshots-mp4` recording. */
export const screenshotsMp4MetadataSchema = z.object({
  frameRefs: z.array(frameRefSchema).default([]),
  fps: z.number().positive().default(2),
  codec: z.string().default("h264"),
  userAgent: z.string().optional(),
  error: z.string().optional(),
})
export type ScreenshotsMp4Metadata = z.infer<
  typeof screenshotsMp4MetadataSchema
>

/** Options for `begin()`. */
export const beginRecordingInputSchema = z.object({
  kind: z.enum(["screenshots-mp4", "rrweb", "webm-capture", "har"]),
  title: z.string().max(200).optional(),
  startUrl: z.string().optional(),
  conversationId: z.uuid().optional(),
  browserSessionId: z.uuid().optional(),
  /**
   * Provider tab handle. Stored on the row so server-side resolution
   * (`findActiveByTabId`) works on cold-start without the agent threading
   * recordingId through every step. Provider-agnostic — camofox returns
   * its own UUID, self-hosted chromium returns a Playwright Page guid.
   */
  tabId: z.string().optional(),
  fps: z.number().positive().optional(),
  /** Custom TTL in days. Defaults to 30 at the service level. */
  ttlDays: z.number().int().positive().optional(),
})
export type BeginRecordingInput = z.infer<typeof beginRecordingInputSchema>

/** Metadata-only view (what the API returns when listing). */
export interface BrowserRecordingMetadata {
  id: string
  userId: string
  conversationId: string | null
  browserSessionId: string | null
  /** Provider tab handle bound to this recording. Null for legacy rows. */
  tabId: string | null
  kind: BrowserRecordingKind
  status: BrowserRecordingStatus
  title: string | null
  startUrl: string | null
  artifactUrl: string | null
  artifactMimeType: string | null
  artifactSizeBytes: number | null
  thumbnailUrl: string | null
  durationMs: number | null
  frameCount: number
  startedAt: Date
  completedAt: Date | null
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** Full detail (list + the metadata JSONB, for the player). */
export interface BrowserRecordingDetail extends BrowserRecordingMetadata {
  metadata: Record<string, unknown>
}

/** Scopes used by API keys and OAuth clients for browser-recording endpoints. */
export const BROWSER_RECORDING_SCOPES = {
  READ: "browser_recording:read",
  WRITE: "browser_recording:write",
} as const
