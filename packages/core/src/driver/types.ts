/**
 * Types for the live browser-driver domain.
 *
 * A `BrowserDriver` is a transport-agnostic handle to a single Chromium tab or
 * page that speaks the Chrome DevTools Protocol. Two backends implement it:
 *
 *  - `extension`  — runs inside the user's browser via `chrome.debugger`. Uses
 *                   the real profile (cookies, logins) and is reached from the
 *                   server through a connect WS tunnel.
 *  - `headless`   — runs server-side via Playwright/CDP in a sandboxed Chromium
 *                   (e.g. e2b). Empty profile unless a `session/` cookie jar is
 *                   injected at start.
 *
 * Tool implementations in `driver/mcp-tools.ts` are written once against this
 * interface; only the backend differs.
 */

import { z } from "zod"

// ---------- Kind & capabilities ----------

export const browserDriverKindSchema = z.enum([
  "extension", // chrome.debugger inside the user's browser (live profile)
  "headless", // server-side Playwright/CDP
  "chromium-service", // remote heavy Chromium webservice (apps/service)
  "camofox", // stealth Firefox
  "stagehand", // Stagehand AI automation (cloud)
  "browserbase", // Browserbase cloud
  "mcp", // adapter onto an external MCP browser server (e.g. chrome-devtools-mcp)
  "cua", // computer-use agent (screen/AX driving)
])
export type BrowserDriverKind = z.infer<typeof browserDriverKindSchema>

/**
 * Per-backend feature flags. MCP tools (and the scrape router) branch on these
 * instead of on the kind, so we can ship new backends without touching tool
 * code. The `can*` capability flags pair with the optional mixin interfaces in
 * `./capabilities.ts`: a driver that sets `canScreencast` MUST implement
 * `SupportsScreencast`, and callers gate on the flag (or the type guard).
 */
export interface BrowserDriverCapabilities {
  /** Can read HTTP response bodies (requires CDP `Network.getResponseBody`). */
  readonly canCaptureResponseBodies: boolean
  /** Can dispatch trusted input events (CDP `Input.*` vs DOM-synthesized). */
  readonly canDispatchTrustedInput: boolean
  /** Can attach to multiple tabs/pages concurrently. */
  readonly canMultiTarget: boolean
  /** Can throttle network / emulate offline. */
  readonly canThrottleNetwork: boolean
  /** Whether the user can see what the driver is doing (e.g. extension shows debugger banner). */
  readonly isUserVisible: boolean
  /** CDP screencast stream → frames (live preview / recording). Implements `SupportsScreencast`. */
  readonly canScreencast: boolean
  /** Native video recording (WebM/MP4, not stitched frames). Implements `SupportsRecording`. */
  readonly canRecordVideo: boolean
  /** Anti-bot fingerprint evasion (stealth backends: Camofox, headless-stealth). */
  readonly canStealth: boolean
  /**
   * Can capture a full-page screenshot natively (CDP `captureBeyondViewport`
   * or Playwright's Chromium `fullPage`). Gecko backends (Camofox) have no
   * such primitive — `mcp-tools.ts` falls back to scrolling + one file per
   * viewport-height segment when this is false.
   */
  readonly canFullPageScreenshot: boolean
  /** High-level AI act/observe/extract/agent (Stagehand/Browserbase). Implements `SupportsAiActions`. */
  readonly canAiActions: boolean
  /** Can export/import the cookie jar for session bridging. Implements `SupportsCookies`. Optional → additive. */
  readonly canCookies?: boolean
}

// ---------- Target identity ----------

/** Identifies a single tab (extension) or page (headless) the driver is bound to. */
export const browserTargetSchema = z.object({
  /** Stable id within the driver session — tab id (extension) or page guid (headless). */
  id: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
})
export type BrowserTarget = z.infer<typeof browserTargetSchema>

// ---------- CDP escape hatch ----------

/** Raw CDP command. `method` is e.g. "Page.navigate", "Runtime.evaluate". */
export interface CDPCommand<TParams = unknown> {
  method: string
  params?: TParams
}

/** Raw CDP event emitted by the attached target. */
export interface CDPEvent<TParams = unknown> {
  method: string
  params: TParams
}

export type CDPEventListener = (event: CDPEvent) => void
export type Unsubscribe = () => void

// ---------- Target descriptor (CDP `Target.getTargets` response) ----------

/**
 * Faithful subset of CDP's `TargetInfo`. Returned by drivers that
 * implement `Target.getTargets` (or its dedicated equivalent —
 * extension drivers mirror it via `chrome.tabs.query`). Web UIs that
 * list "which tab am I attached to?" render from this shape.
 */
export interface CDPTargetInfo {
  targetId: string
  type: "page"
  title: string
  url: string
  attached: boolean
  /** Mirror of CDP's field; null/undefined when the target has no opener. */
  openerId?: string
}

/** CDP `Target.getTargets` response shape. */
export interface CDPGetTargetsResult {
  targetInfos: CDPTargetInfo[]
}

// ---------- Network capture ----------

/** Summary of a single network request, surfaced to agents via MCP tools. */
export const networkRequestSummarySchema = z.object({
  requestId: z.string(),
  url: z.string(),
  method: z.string(),
  resourceType: z.string().optional(),
  status: z.number().optional(),
  statusText: z.string().optional(),
  fromCache: z.boolean().optional(),
  startedAt: z.number(), // ms epoch
  completedAt: z.number().optional(),
  requestHeaders: z.record(z.string(), z.string()).optional(),
  responseHeaders: z.record(z.string(), z.string()).optional(),
  /** Only populated lazily via `getRequestBody(requestId)`. */
  hasResponseBody: z.boolean().optional(),
})
export type NetworkRequestSummary = z.infer<typeof networkRequestSummarySchema>

// ---------- Tool-level options ----------

export const navigateOptionsSchema = z.object({
  url: z.string(),
  /** Promise resolves when this lifecycle event fires. */
  waitUntil: z
    .enum(["load", "domcontentloaded", "networkidle"])
    .default("load"),
  timeoutMs: z.number().int().positive().optional(),
})
export type NavigateOptions = z.infer<typeof navigateOptionsSchema>

export const evaluateOptionsSchema = z.object({
  expression: z.string(),
  awaitPromise: z.boolean().default(true),
  returnByValue: z.boolean().default(true),
  /** Cap on serialized result size; oversize results return a truncation marker. */
  maxResultBytes: z.number().int().positive().default(64_000),
})
export type EvaluateOptions = z.infer<typeof evaluateOptionsSchema>

export const clickOptionsSchema = z.object({
  selector: z.string(),
  button: z.enum(["left", "middle", "right"]).default("left"),
  clickCount: z.number().int().min(1).max(3).default(1),
  /** Force trusted CDP input even if a synthetic-DOM fallback would be cheaper. */
  trusted: z.boolean().default(true),
})
export type ClickOptions = z.infer<typeof clickOptionsSchema>

export const fillOptionsSchema = z.object({
  selector: z.string(),
  value: z.string(),
  /** Clear existing value first. */
  clear: z.boolean().default(true),
})
export type FillOptions = z.infer<typeof fillOptionsSchema>

export const screenshotOptionsSchema = z.object({
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
  quality: z.number().int().min(1).max(100).optional(),
  /**
   * Capture the whole scrollable page, not just the viewport. Native on
   * drivers with `capabilities.canFullPageScreenshot` (CDP
   * `captureBeyondViewport` / Playwright Chromium). On drivers without it
   * (Gecko/Camofox) `mcp-tools.ts` falls back to scrolling in viewport-height
   * steps and writing one file per segment — `path` is required for that
   * fallback and the result becomes `ScreenshotSegmentsResult`.
   */
  fullPage: z.boolean().default(false),
  /** Optional CSS selector to clip to. */
  selector: z.string().optional(),
  /**
   * When set, write the image to this file (on the driver host) and return
   * `{ path, bytes, width, height }` instead of base64 (or, for the
   * no-native-fullPage segment fallback, `{ paths, segments, ... }` with
   * `path-1.ext`, `path-2.ext`, … alongside it). Strongly preferred for
   * full-page / large captures so the bytes don't bloat the tool response.
   * Relative paths resolve against the Bureau artifacts dir.
   */
  path: z.string().optional(),
})
export type ScreenshotOptions = z.infer<typeof screenshotOptionsSchema>

// ---------- The driver interface ----------

export interface EvaluateResult<T = unknown> {
  value: T | undefined
  /** True when the result was clipped to `maxResultBytes`. */
  truncated: boolean
}

export interface ScreenshotResult {
  /** Base64-encoded image bytes. */
  base64: string
  format: "png" | "jpeg" | "webp"
  width: number
  height: number
}

/**
 * Returned by `browser_screenshot` (and the export `png` path) when `path` is
 * set — the image was written to disk on the driver host instead of returned as
 * base64, so the response stays small.
 */
export interface ScreenshotFileResult {
  /** Absolute path of the written image on the driver host. */
  path: string
  format: "png" | "jpeg" | "webp"
  /** Image size in bytes. */
  bytes: number
  width: number
  height: number
}

/**
 * Returned by `browser_screenshot` when `fullPage` is requested on a driver
 * without native full-page capture (`capabilities.canFullPageScreenshot ===
 * false`, e.g. Camofox/Gecko). The tool layer scrolls the page in
 * viewport-height increments and writes one file per segment instead of
 * stitching — no image-compositing dependency, and each segment stays a
 * normal-sized screenshot.
 */
export interface ScreenshotSegmentsResult {
  /** Absolute paths of the written segment files, top of page first. */
  paths: string[]
  format: "png" | "jpeg" | "webp"
  /** Number of segments written (capped — see `truncated`). */
  segments: number
  viewportWidth: number
  viewportHeight: number
  /** Full document scroll height in CSS px. */
  totalHeight: number
  /** True if the page was taller than the segment cap allows — the returned
   *  segments cover only the top of the page. */
  truncated: boolean
}

/**
 * Live handle to a Chromium target. Created by a `BrowserDriverProvider`;
 * disposed via `close()`. All methods are async and may throw on detach.
 */
export interface BrowserDriver {
  readonly kind: BrowserDriverKind
  readonly capabilities: BrowserDriverCapabilities
  readonly target: BrowserTarget

  // --- High-level ops (used by mcp-tools.ts) ---
  navigate(options: NavigateOptions): Promise<void>
  evaluate<T = unknown>(options: EvaluateOptions): Promise<EvaluateResult<T>>
  click(options: ClickOptions): Promise<void>
  fill(options: FillOptions): Promise<void>
  screenshot(options: ScreenshotOptions): Promise<ScreenshotResult>
  /** Serialized DOM (outerHTML of documentElement, post-render). */
  getDom(selector?: string): Promise<string>

  // --- Network ---
  /** Recent network requests, newest last. Backed by an in-memory ring buffer. */
  listRequests(opts?: {
    since?: number
    limit?: number
  }): Promise<NetworkRequestSummary[]>
  /** Fetch a request's response body. Requires `capabilities.canCaptureResponseBodies`. */
  getRequestBody(
    requestId: string
  ): Promise<{ body: string; base64Encoded: boolean }>

  // --- Raw CDP escape hatch ---
  send<TResult = unknown, TParams = unknown>(
    command: CDPCommand<TParams>
  ): Promise<TResult>
  onEvent(method: string, listener: CDPEventListener): Unsubscribe

  // --- Browser-wide ops (optional) ---
  // These are provider-level concepts (operate above a single tab),
  // exposed via the driver for convenience so the agent doesn't need
  // a separate handle. Tunneled drivers route them to the extension's
  // provider tools (chrome.tabs.*); headless backends may stub them
  // with single-page semantics or omit them entirely.

  /** List all tabs/pages in the user's browser. */
  listTabs?(): Promise<BrowserTarget[]>
  /** Open a new tab — agent gets a clean automation surface that
   *  doesn't fight DevTools sessions the user has open elsewhere. */
  openTab?(opts: { url?: string; active?: boolean }): Promise<BrowserTarget>
  /** Pin subsequent tab-scoped ops to a specific tab id. */
  focusTab?(tabId: string): Promise<BrowserTarget>

  // --- Lifecycle ---
  close(): Promise<void>
  readonly closed: boolean
}

// ---------- Provider (factory) ----------

/**
 * Per-backend factory. The server-side runtime picks one based on the
 * workspace's `browserProvider` setting and asks it to attach to a target.
 */
export interface BrowserDriverProvider {
  readonly kind: BrowserDriverKind
  readonly capabilities: BrowserDriverCapabilities

  /**
   * Acquire a driver. For `extension`, `targetId` selects the user's tab
   * (defaults to active tab). For `headless`, `targetId` is ignored and a new
   * page is created — optional `sessionPayload` seeds cookies/localStorage.
   */
  attach(options: AttachOptions): Promise<BrowserDriver>

  /** Enumerate live targets (tabs/pages) — used by UIs that let the user pick. */
  listTargets(): Promise<BrowserTarget[]>

  // --- Browser-wide tab ops (optional) ---
  // Providers that can manage tabs natively (extension via chrome.tabs.*)
  // implement these; backends that can't (headless creates a fresh page per
  // attach) omit them and let mcp-tools.ts fall back to `attach()`. Mirrors
  // the optional mixin pattern on `BrowserDriver`.

  /** Open a new tab without burning a per-tab debugger slot just to spawn it. */
  openTab?(opts: { url?: string; active?: boolean }): Promise<BrowserTarget>
  /** Cache a tab id for subsequent attach() calls (deferred reattach). */
  focusTab?(tabId: string): Promise<BrowserTarget>
}

/**
 * How human-like a driver's interactions are — paced navigation, jittered
 * typing, settled clicks — chosen per session, not per call (a single raw
 * action de-anonymizes the whole session, and a per-call flag is forgotten).
 * A backend that has no notion of pacing (headless Chromium, extension) ignores
 * it; the stealth camofox backend reads it.
 *
 *   - `human` (the default): typing is keystroke-jittered, clicks settle before
 *     the next action, navigation pauses to "read". Invisible to the caller.
 *   - `fast`: raw, instant — the opt-OUT for speed / debugging, accepting the
 *     bot-shaped timing signature.
 *   - `stealth`: human pacing plus anti-bot awareness (surfaces a challenge wall
 *     instead of silently reading an empty page).
 */
export type BehaviorProfile = "human" | "fast" | "stealth"

export interface AttachOptions {
  targetId?: string
  /** Initial URL for headless backends; ignored when attaching to an existing tab. */
  initialUrl?: string
  /**
   * Optional cookie/localStorage seed (typically a decrypted
   * `BrowserSessionPayload` from the `session/` subpath). Headless backends
   * inject before first navigation; extension backends ignore (the user's
   * profile is already loaded).
   */
  sessionPayload?: unknown
  /**
   * Interaction realism for this session (default `human`). Pacing-capable
   * backends (camofox) apply it below the tool surface; others ignore it.
   */
  behavior?: BehaviorProfile
}

// ---------- Scopes ----------

export const BROWSER_DRIVER_SCOPES = {
  ATTACH: "browser_driver:attach",
  CONTROL: "browser_driver:control",
} as const
