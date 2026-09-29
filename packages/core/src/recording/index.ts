/**
 * Browser recording domain — agnostic types + port + in-process tab index.
 * DB persistence (base-columns, services, factories) lives in a separate store adapter.
 */

export {
  frameRefSchema,
  screenshotsMp4MetadataSchema,
  beginRecordingInputSchema,
  FRAME_EVENTS,
  BROWSER_RECORDING_SCOPES,
  BROWSER_RECORDING_KINDS,
  BROWSER_RECORDING_STATUSES,
  type BrowserRecordingKind,
  type BrowserRecordingStatus,
  type FrameRef,
  type FrameEvent,
  type ScreenshotsMp4Metadata,
  type BeginRecordingInput,
  type BrowserRecordingMetadata,
  type BrowserRecordingDetail,
} from "./types.js"

export type { BrowserRecordingProvider } from "./provider.js"

// In-process tab → recording binding (cache; DB is source of truth on miss)
export {
  setTabBinding,
  getTabBinding,
  clearTabBinding,
  nextFrameIndex,
  clearAllTabBindings,
  tabBindingCount,
  type TabBinding,
} from "./tab-index.js"
