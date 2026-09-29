/**
 * Live browser-driver domain — CDP-shaped interface over two backends:
 *
 *  - extension (chrome.debugger) — implemented by the extension package
 *  - headless  (Playwright/CDP)  — implemented here
 *
 * MCP tools written against `BrowserDriver` work uniformly across both.
 */

export {
  browserDriverKindSchema,
  browserTargetSchema,
  navigateOptionsSchema,
  evaluateOptionsSchema,
  clickOptionsSchema,
  fillOptionsSchema,
  screenshotOptionsSchema,
  networkRequestSummarySchema,
  BROWSER_DRIVER_SCOPES,
  type BrowserDriverKind,
  type BrowserDriverCapabilities,
  type BrowserTarget,
  type CDPCommand,
  type CDPEvent,
  type CDPEventListener,
  type CDPGetTargetsResult,
  type CDPTargetInfo,
  type Unsubscribe,
  type NetworkRequestSummary,
  type NavigateOptions,
  type EvaluateOptions,
  type EvaluateResult,
  type ClickOptions,
  type FillOptions,
  type ScreenshotOptions,
  type ScreenshotResult,
  type BrowserDriver,
  type BrowserDriverProvider,
  type AttachOptions,
  type BehaviorProfile,
} from "./types.js"

export {
  supportsScreencast,
  supportsRecording,
  supportsAiActions,
  supportsCookies,
  type SupportsScreencast,
  type SupportsRecording,
  type SupportsAiActions,
  type SupportsCookies,
  type ScreencastFrame,
  type RecordedVideo,
  type ActResult,
  type ObserveResult,
  type AiExtractResult,
  type AgentRunResult,
} from "./capabilities.js"

export {
  bridgeCookies,
  listCookies,
  type BridgeCookiesOptions,
  type BridgeCookiesResult,
} from "./cookies.js"

export {
  createBrowserMcpTools,
  createBrowserProviderMcpTools,
  toMcpToolDescriptors,
  type ArtifactWriter,
  type CreateBrowserMcpToolsOptions,
  type BrowserMcpTool,
  type BrowserProviderMcpTool,
} from "./mcp-tools.js"

// Node-only artifact helpers (fs/path/os) are NOT re-exported here — that would
// pull node builtins into the `driver` bundle and break the in-browser
// extension build. Import them from `@agentproto/bureau-core/artifacts` instead.

export {
  HeadlessBrowserDriverProvider,
  type HeadlessProviderOptions,
} from "./headless.js"

export {
  BrowserMcpServerAdapter,
  type BrowserMcpServerAdapterOptions,
} from "./mcp-server-adapter.js"

export {
  TunneledBrowserDriver,
  type TunneledBrowserDriverOptions,
  type TunneledSendRequest,
} from "./tunneled.js"
