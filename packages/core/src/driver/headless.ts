/**
 * Headless `BrowserDriver` backend. Uses Playwright to launch a sandboxed
 * Chromium, then drives it primarily through a raw CDP session — same protocol
 * the extension impl speaks, so the `BrowserDriver` surface stays uniform.
 *
 * Playwright is an optional peer dep: it's loaded via dynamic `import()` only
 * when this provider is actually used. Apps that never need headless control
 * (e.g. extension-only deployments) don't have to install it.
 */

import type {
  Browser as PwBrowser,
  BrowserContext as PwContext,
  CDPSession as PwCDPSession,
  Page as PwPage,
} from "playwright"
import type {
  AttachOptions,
  BrowserDriver,
  BrowserDriverCapabilities,
  BrowserDriverProvider,
  BrowserTarget,
  CDPCommand,
  CDPEventListener,
  ClickOptions,
  EvaluateOptions,
  EvaluateResult,
  FillOptions,
  NavigateOptions,
  NetworkRequestSummary,
  ScreenshotOptions,
  ScreenshotResult,
  Unsubscribe,
} from "./types.js"
import type { ScreencastFrame, SupportsScreencast } from "./capabilities.js"
import { browserSessionPayloadSchema } from "../session/types.js"

/** Playwright's `storageState` shape for `browser.newContext({ storageState })`. */
type PwStorageState = NonNullable<
  Parameters<PwBrowser["newContext"]>[0]
>["storageState"]

/**
 * Translate a decrypted `BrowserSessionPayload` (our `session/` cookie jar)
 * into Playwright's `storageState`. The two cookie shapes differ:
 *  - our `expires`/httpOnly/secure/sameSite are optional; Playwright wants them
 *    present (`expires: -1` = session cookie, sameSite defaults to "Lax").
 *  - localStorage is keyed by origin in both, but Playwright nests it under
 *    `origins: [{ origin, localStorage: [{ name, value }] }]`.
 * Returns `undefined` when the payload doesn't match the expected shape, so
 * the context launches clean rather than throwing on a malformed seed.
 *
 * TODO(cookie-format): reconcile this with the extension's capture format so
 * `session/` and Playwright share one canonical cookie schema.
 */
function toPlaywrightStorageState(payload: unknown): PwStorageState {
  const parsed = browserSessionPayloadSchema.safeParse(payload)
  if (!parsed.success) return undefined
  const session = parsed.data
  const cookies = session.cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure ?? false,
    sameSite: c.sameSite ?? ("Lax" as const),
  }))
  const origins = Object.entries(session.localStorage ?? {}).map(
    ([origin, kv]) => ({
      origin,
      localStorage: Object.entries(kv).map(([name, value]) => ({
        name,
        value,
      })),
    })
  )
  return { cookies, origins }
}

const HEADLESS_CAPABILITIES: BrowserDriverCapabilities = {
  canCaptureResponseBodies: true,
  canDispatchTrustedInput: true,
  canMultiTarget: true,
  canThrottleNetwork: true,
  isUserVisible: false,
  canScreencast: true,
  canRecordVideo: false,
  canStealth: false,
  canAiActions: false,
  canFullPageScreenshot: true, // Playwright Chromium screenshot({ fullPage: true })
}

/** Keep ~30s at 10fps — the screencast ring buffer the stitch job consumes. */
const MAX_SCREENCAST_FRAMES = 300

// Stealth flavour — same Playwright Chromium, launched with
// anti-fingerprint args + a Runtime.evaluateOnNewDocument shim that
// scrubs the most common automation tells (`navigator.webdriver`,
// `chrome` runtime object, plugin enumeration). Mid-tier stealth: gets
// past basic bot checks (low-friction CAPTCHA gates, simple WAFs) but
// NOT determined ones like Cloudflare Bot Fight Mode or
// Akamai/PerimeterX. For those, use the Camoufox provider (separate
// bridge, future work).
const HEADLESS_STEALTH_CAPABILITIES: BrowserDriverCapabilities = {
  ...HEADLESS_CAPABILITIES,
  // Camoufox-like restriction marker — `canDispatchTrustedInput` stays
  // true on Playwright-stealth (we still send raw CDP), but flag it
  // false-ish in the agent's mind by setting `isUserVisible: false` +
  // `canMultiTarget: false` (single page per context is the typical
  // stealth pattern — multi-tab from same context shares fingerprints).
  canMultiTarget: false,
  canStealth: true,
}

const STEALTH_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--no-default-browser-check",
  "--no-first-run",
  "--password-store=basic",
] as const

/** Init script applied to every new document; scrubs the most-checked
 *  automation tells before page JS evaluates `navigator.*`. */
const STEALTH_INIT_SCRIPT = `
  // Remove the standard 'webdriver' flag.
  Object.defineProperty(Navigator.prototype, "webdriver", {
    get: () => undefined,
    configurable: true,
  });
  // chrome.runtime is present in real Chrome; absent on naked Playwright.
  if (!window.chrome) {
    Object.defineProperty(window, "chrome", {
      value: { runtime: {} },
      configurable: true,
    });
  }
  // Plugin enumeration — empty array on headless = bot tell.
  Object.defineProperty(Navigator.prototype, "plugins", {
    get: () => [1, 2, 3, 4, 5],
    configurable: true,
  });
  // Languages — single-lang headless is a tell.
  Object.defineProperty(Navigator.prototype, "languages", {
    get: () => ["en-US", "en"],
    configurable: true,
  });
`

const MAX_REQUEST_BUFFER = 500

export interface HeadlessProviderOptions {
  /** Run Chromium headless (default true). Set false for visible debugging. */
  headless?: boolean
  /** Extra Chromium args passed to Playwright's launch(). */
  args?: string[]
  /**
   * Apply anti-fingerprint launch args + init-script tweaks (scrubs
   * `navigator.webdriver`, fakes `chrome.runtime`, plugin array,
   * `navigator.languages`). Mid-tier stealth; for determined
   * bot-detection (Cloudflare turnstile, Akamai) use the Camoufox
   * provider instead.
   */
  stealth?: boolean
}

export class HeadlessBrowserDriverProvider implements BrowserDriverProvider {
  readonly kind = "headless" as const
  readonly capabilities: BrowserDriverCapabilities

  constructor(private readonly opts: HeadlessProviderOptions = {}) {
    this.capabilities = opts.stealth
      ? HEADLESS_STEALTH_CAPABILITIES
      : HEADLESS_CAPABILITIES
  }

  async attach(options: AttachOptions): Promise<BrowserDriver> {
    const { chromium } =
      (await import("playwright")) as typeof import("playwright")
    const args = [
      ...(this.opts.stealth ? STEALTH_LAUNCH_ARGS : []),
      ...(this.opts.args ?? []),
    ]
    const browser = await chromium.launch({
      headless: this.opts.headless ?? true,
      args,
    })
    const storageState = options.sessionPayload
      ? toPlaywrightStorageState(options.sessionPayload)
      : undefined
    const context = await browser.newContext(
      storageState ? { storageState } : undefined
    )
    if (this.opts.stealth) {
      await context.addInitScript(STEALTH_INIT_SCRIPT)
    }
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    const driver = new HeadlessBrowserDriver(
      browser,
      context,
      page,
      cdp,
      this.capabilities
    )
    await driver.bootstrap()
    if (options.initialUrl) {
      await driver.navigate({ url: options.initialUrl, waitUntil: "load" })
    }
    return driver
  }

  async listTargets(): Promise<BrowserTarget[]> {
    return []
  }
}

class HeadlessBrowserDriver implements BrowserDriver, SupportsScreencast {
  readonly kind = "headless" as const
  readonly capabilities: BrowserDriverCapabilities
  readonly target: BrowserTarget

  private readonly requests = new Map<string, NetworkRequestSummary>()
  private readonly order: string[] = []
  /**
   * CDP `*.timestamp` is MonotonicTime (seconds since an arbitrary epoch), not
   * wall-clock. `requestWillBeSent` carries `wallTime` (epoch seconds) too, so
   * we anchor each request's monotonic start to wall-clock and derive
   * `completedAt` (which only ships monotonic) from the delta.
   */
  private readonly monotonicStart = new Map<string, number>()
  private readonly listeners = new Map<string, Set<CDPEventListener>>()
  private _closed = false

  private screencastFrames: ScreencastFrame[] = []
  private screencastActive = false
  private screencastIndex = 0
  private screencastFormat: "jpeg" | "png" = "jpeg"

  constructor(
    private readonly browser: PwBrowser,
    private readonly context: PwContext,
    private readonly page: PwPage,
    private readonly cdp: PwCDPSession,
    capabilities: BrowserDriverCapabilities
  ) {
    this.capabilities = capabilities
    this.target = { id: `pw-${Date.now()}`, url: page.url() }
  }

  get closed(): boolean {
    return this._closed
  }

  async bootstrap(): Promise<void> {
    await this.cdp.send("Network.enable")
    await this.cdp.send("Page.enable")
    await this.cdp.send("Runtime.enable")

    this.cdp.on("Network.requestWillBeSent", (e: unknown) => {
      const ev = e as {
        requestId: string
        request: {
          url: string
          method: string
          headers: Record<string, string>
        }
        type?: string
        // MonotonicTime (seconds, arbitrary epoch) — relative only.
        timestamp: number
        // Epoch seconds — the real wall-clock send time.
        wallTime: number
      }
      this.monotonicStart.set(ev.requestId, ev.timestamp)
      this.recordRequest({
        requestId: ev.requestId,
        url: ev.request.url,
        method: ev.request.method,
        resourceType: ev.type,
        requestHeaders: ev.request.headers,
        startedAt: Math.round(ev.wallTime * 1000),
      })
    })

    this.cdp.on("Network.responseReceived", (e: unknown) => {
      const ev = e as {
        requestId: string
        response: {
          status: number
          statusText: string
          headers: Record<string, string>
          fromDiskCache?: boolean
        }
      }
      const summary = this.requests.get(ev.requestId)
      if (!summary) return
      summary.status = ev.response.status
      summary.statusText = ev.response.statusText
      summary.responseHeaders = ev.response.headers
      summary.fromCache = ev.response.fromDiskCache
      summary.hasResponseBody = true
    })

    this.cdp.on("Network.loadingFinished", (e: unknown) => {
      const ev = e as { requestId: string; timestamp: number }
      const summary = this.requests.get(ev.requestId)
      if (!summary) return
      // `loadingFinished` only carries MonotonicTime — convert to epoch by
      // adding the monotonic delta to the request's wall-clock `startedAt`.
      const monoStart = this.monotonicStart.get(ev.requestId)
      summary.completedAt =
        monoStart !== undefined
          ? Math.round(summary.startedAt + (ev.timestamp - monoStart) * 1000)
          : summary.startedAt
    })
  }

  private recordRequest(req: NetworkRequestSummary): void {
    this.requests.set(req.requestId, req)
    this.order.push(req.requestId)
    while (this.order.length > MAX_REQUEST_BUFFER) {
      const evicted = this.order.shift()
      if (evicted) {
        this.requests.delete(evicted)
        this.monotonicStart.delete(evicted)
      }
    }
  }

  async navigate(options: NavigateOptions): Promise<void> {
    const waitUntil =
      options.waitUntil === "networkidle"
        ? "networkidle"
        : options.waitUntil === "domcontentloaded"
          ? "domcontentloaded"
          : "load"
    await this.page.goto(options.url, { waitUntil, timeout: options.timeoutMs })
    this.target.url = this.page.url()
  }

  // ── Screencast (SupportsScreencast) ──────────────────────────────────
  // CDP `Page.startScreencast` streams JPEG frames of the viewport as the
  // page changes. Buffered in a ring (last ~30s); the recording domain's
  // `screenshots-mp4` stitch job consumes these frames. Chromium does this
  // natively — the in-process headless driver had simply not wired it.

  private onScreencastFrame = (e: unknown): void => {
    if (!this.screencastActive) return
    const ev = e as { data: string; sessionId: number }
    this.screencastFrames.push({
      data: ev.data,
      format: this.screencastFormat,
      timestampMs: Date.now(),
      index: this.screencastIndex++,
    })
    if (this.screencastFrames.length > MAX_SCREENCAST_FRAMES) {
      this.screencastFrames.shift()
    }
    void this.cdp
      .send("Page.screencastFrameAck", { sessionId: ev.sessionId })
      .catch(() => {})
  }

  async startScreencast(opts?: {
    format?: "jpeg" | "png"
    quality?: number
    everyNthFrame?: number
  }): Promise<void> {
    if (this.screencastActive) return
    this.screencastFrames = []
    this.screencastIndex = 0
    this.screencastFormat = opts?.format ?? "jpeg"
    this.screencastActive = true
    this.cdp.on("Page.screencastFrame", this.onScreencastFrame)
    await this.cdp.send("Page.startScreencast", {
      format: this.screencastFormat,
      quality: opts?.quality ?? 60,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: opts?.everyNthFrame ?? 3,
    })
  }

  async stopScreencast(): Promise<{ frameCount: number }> {
    if (!this.screencastActive) {
      return { frameCount: this.screencastFrames.length }
    }
    this.screencastActive = false
    await this.cdp.send("Page.stopScreencast").catch(() => {})
    this.cdp.off("Page.screencastFrame", this.onScreencastFrame)
    return { frameCount: this.screencastFrames.length }
  }

  async getScreencastFrames(opts?: {
    offset?: number
    limit?: number
  }): Promise<{ frames: ScreencastFrame[]; totalFrames: number }> {
    const offset = opts?.offset ?? 0
    const limit = opts?.limit ?? this.screencastFrames.length
    return {
      frames: this.screencastFrames.slice(offset, offset + limit),
      totalFrames: this.screencastFrames.length,
    }
  }

  async evaluate<T = unknown>(
    options: EvaluateOptions
  ): Promise<EvaluateResult<T>> {
    const result = (await this.cdp.send("Runtime.evaluate", {
      expression: options.expression,
      awaitPromise: options.awaitPromise,
      returnByValue: options.returnByValue,
    })) as { result: { value: unknown }; exceptionDetails?: { text: string } }

    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.text}`)
    }

    const serialized = JSON.stringify(result.result.value)
    const truncated =
      serialized !== undefined && serialized.length > options.maxResultBytes
    return {
      value: truncated ? undefined : (result.result.value as T),
      truncated,
    }
  }

  async click(options: ClickOptions): Promise<void> {
    await this.page.click(options.selector, {
      button: options.button,
      clickCount: options.clickCount,
    })
    // A click may trigger navigation (form submit, link). Keep target.url
    // in sync so callers reading it after the action (e.g. the act loop's
    // finalUrl) reflect where the page actually ended up.
    this.target.url = this.page.url()
  }

  async fill(options: FillOptions): Promise<void> {
    if (options.clear) await this.page.fill(options.selector, "")
    await this.page.fill(options.selector, options.value)
  }

  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    const target = options.selector
      ? this.page.locator(options.selector)
      : this.page
    // Playwright Chromium has no webp encoder — fall back to PNG and report
    // the format that actually matches the returned bytes (not the request).
    const encodedFormat = options.format === "webp" ? "png" : options.format
    const buf = await target.screenshot({
      type: encodedFormat,
      quality: encodedFormat === "jpeg" ? options.quality : undefined,
      fullPage: options.selector ? undefined : options.fullPage,
    })
    const viewport = this.page.viewportSize() ?? { width: 0, height: 0 }
    return {
      base64: buf.toString("base64"),
      format: encodedFormat,
      width: viewport.width,
      height: viewport.height,
    }
  }

  async getDom(selector?: string): Promise<string> {
    if (selector) {
      return (
        (await this.page
          .locator(selector)
          .first()
          .evaluate((el: { outerHTML: string }) => el.outerHTML)) ?? ""
      )
    }
    return await this.page.content()
  }

  async listRequests(opts?: {
    since?: number
    limit?: number
  }): Promise<NetworkRequestSummary[]> {
    const since = opts?.since ?? 0
    const limit = opts?.limit ?? 100
    const out: NetworkRequestSummary[] = []
    for (let i = this.order.length - 1; i >= 0 && out.length < limit; i--) {
      const req = this.requests.get(this.order[i]!)
      if (req && req.startedAt >= since) out.push(req)
    }
    return out.reverse()
  }

  async getRequestBody(
    requestId: string
  ): Promise<{ body: string; base64Encoded: boolean }> {
    const res = (await this.cdp.send("Network.getResponseBody", {
      requestId,
    })) as {
      body: string
      base64Encoded: boolean
    }
    return res
  }

  async send<TResult = unknown, TParams = unknown>(
    command: CDPCommand<TParams>
  ): Promise<TResult> {
    return (await this.cdp.send(
      command.method as never,
      command.params as never
    )) as TResult
  }

  onEvent(method: string, listener: CDPEventListener): Unsubscribe {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
      this.cdp.on(method as never, (params: unknown) => {
        const s = this.listeners.get(method)
        if (s) for (const l of s) l({ method, params })
      })
    }
    set.add(listener)
    return () => {
      set?.delete(listener)
    }
  }

  async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    // Tear down the screencast stream + its frame listener so it doesn't keep
    // firing (and ack-ing) against a detaching session.
    if (this.screencastActive) {
      this.screencastActive = false
      await this.cdp.send("Page.stopScreencast").catch(() => {})
    }
    this.cdp.off("Page.screencastFrame", this.onScreencastFrame)
    this.listeners.clear()
    await this.cdp.detach().catch(() => {})
    await this.context.close().catch(() => {})
    await this.browser.close().catch(() => {})
  }
}
