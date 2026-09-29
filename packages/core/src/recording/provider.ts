/**
 * Provider interface used by the agent-tools browser tool to emit recording
 * lifecycle events without knowing about databases or job systems.
 *
 * Implementations live in the host apps; they wrap the recording service and
 * submit the stitch job.
 */

import type {
  BeginRecordingInput,
  BrowserRecordingMetadata,
  FrameRef,
} from "./types.js"

export interface BrowserRecordingProvider {
  /**
   * Start a new recording. Returns the recording id, or `null` if recording
   * is disabled for this user/context (caller should then skip all other
   * recording calls — no-op).
   */
  begin(userId: string, input: BeginRecordingInput): Promise<string | null>

  /** Append a captured frame to an open recording. Must tolerate unknown ids. */
  appendFrame(recordingId: string, frame: FrameRef): Promise<void>

  /**
   * Finalize the recording — marks it processing and submits the
   * appropriate worker job (recording-stitch for screenshots-mp4,
   * recording-video-finalize for webm-capture). Safe to call multiple
   * times / after errors.
   *
   * The optional second arg lets `webm-capture` sessions pass the
   * already-uploaded video artifact so finalize doesn't need to
   * re-upload. Older call sites that omit it default to the
   * screenshots-mp4 flow.
   */
  finalize(
    recordingId: string,
    artifact?: {
      kind: "webm-capture"
      artifactPath: string
      mimeType: string
      sizeBytes: number
    }
  ): Promise<void>

  /** Mark the recording as failed with a reason. */
  markFailed(recordingId: string, error: string): Promise<void>

  /** List recordings for a user — used by the `browser_recordings_list` tool. */
  list(
    userId: string,
    opts?: { limit?: number }
  ): Promise<BrowserRecordingMetadata[]>

  /**
   * Revoke a recording. Soft by default (status=expired), `hard: true`
   * deletes the row. User-scoped — recordings owned by a different user
   * are silently no-op'd.
   *
   * Used by `browser_recordings_revoke` to clean up orphaned recordings
   * (those left in `recording` state with no `browserSessionId` because
   * the tab they tracked was already destroyed by Camofox).
   */
  revoke(
    userId: string,
    recordingId: string,
    options?: { hard?: boolean }
  ): Promise<void>

  /**
   * Resolve the active recording bound to a tab, by tabId alone.
   *
   * Used by `browser_step` / `browser_close` when the in-process tab-index
   * cache misses (cold-start, multi-instance scaling). Implementations
   * delegate to `recordingService.findActiveByTabId`.
   *
   * Returns null when there's no active recording for that tab — callers
   * should skip frame capture in that case.
   */
  resolveTab(
    userId: string,
    tabId: string
  ): Promise<BrowserRecordingMetadata | null>

  /**
   * Background sweep: mark recordings stuck in `status="recording"`
   * longer than the TTL as failed. Run by the worker cron in Slice 9.
   * Returns the count of rows that transitioned.
   */
  expireOrphans(olderThanMinutes?: number): Promise<number>
}
