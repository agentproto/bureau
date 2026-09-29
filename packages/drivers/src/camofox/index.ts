/**
 * Camofox BrowserDriver backend — stealth Firefox (Camoufox fork), reached over
 * the Camofox service REST API. Wraps the legacy CamofoxBrowserProvider onto the
 * unified BrowserDriver port.
 *
 * What it does: stealth navigate + content + screenshot + deterministic
 * click/fill (the service resolves CSS selectors → accessibility refs server-
 * side) + cookie injection at attach (browse-as-the-user) + optional native
 * video + in-page `evaluate` (the service runs Playwright `page.evaluate`
 * server-side; no CDP Runtime needed). What it can't: raw CDP (`send`/`onEvent`)
 * and network capture (`listRequests`/`getRequestBody`) — Gecko has no DevTools
 * protocol here. Those throw; `capabilities` declares the limits so callers gate
 * via the type guards rather than calling blindly.
 */

import type { CamofoxClient } from "./client.js"
import {
  sleep,
  navDwellMs,
  actionSettleMs,
  typingOptions,
  BLOCKED_PAGE_EXPRESSION,
} from "./behavior.js"
import type {
  AttachOptions,
  BehaviorProfile,
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
  RecordedVideo,
  ScreenshotOptions,
  ScreenshotResult,
  SupportsRecording,
  SupportsCookies,
  Unsubscribe,
} from "@agentproto/bureau-core/driver"
import type { CookieJson } from "@agentproto/bureau-core"
import { cookieJsonSchema } from "@agentproto/bureau-core"
import { z } from "zod"
import type { BrowserDriverRegistry } from "../index.js"

const CAMOFOX_CAPABILITIES: BrowserDriverCapabilities = {
  canCaptureResponseBodies: false,
  canDispatchTrustedInput: true, // real Firefox input via the service
  canMultiTarget: true, // Camofox addresses tabs per userId
  canThrottleNetwork: false,
  isUserVisible: false,
  canScreencast: false, // Gecko CDP shim has no Page.startScreencast
  canRecordVideo: process.env.CAMOFOX_NATIVE_VIDEO === "true",
  canStealth: true,
  canAiActions: false, // deterministic only; AI goes through the code-as-action agent
  canCookies: true, // setCookies via the service; getCookies has no endpoint (receive-only)
  canFullPageScreenshot: false, // Gecko, no CDP captureBeyondViewport — mcp-tools falls back to segments
}

const NOT_SUPPORTED = (op: string): never => {
  throw new Error(`camofox driver: ${op} is not supported (Gecko, no CDP)`)
}

/** Validate the foreign attach payload's cookie jar before injecting it. */
const ATTACH_PAYLOAD_SCHEMA = z
  .object({ cookies: z.array(cookieJsonSchema).optional() })
  .loose()

/**
 * Resolve the session's behavior profile: an explicit attach option wins, else
 * the daemon-level `BUREAU_BEHAVIOR` env knob, else `human`. Human pacing is the
 * default precisely because a single raw session de-anonymizes everything it
 * touches — `fast` is an opt-OUT a deployment makes deliberately.
 */
function resolveBehavior(explicit?: BehaviorProfile): BehaviorProfile {
  if (explicit) return explicit
  const env = process.env.BUREAU_BEHAVIOR
  if (env === "fast" || env === "stealth" || env === "human") return env
  return "human"
}

/** Map the unified waitUntil onto the legacy provider's Puppeteer-style enum. */
function mapWaitUntil(
  w: NavigateOptions["waitUntil"]
): "load" | "domcontentloaded" | "networkidle2" {
  return w === "networkidle" ? "networkidle2" : w
}

export interface CamofoxDriverProviderOptions {
  /**
   * The Camofox REST client (e.g. the legacy `CamofoxBrowserProvider`),
   * injected so this package stays free of the integration layer. Construct
   * it at the composition edge and pass it in.
   */
  client: CamofoxClient
}

class CamofoxDriver
  implements BrowserDriver, SupportsRecording, SupportsCookies
{
  readonly kind = "camofox" as const
  readonly capabilities = CAMOFOX_CAPABILITIES
  closed = false

  constructor(
    private readonly provider: CamofoxClient,
    private readonly sessionId: string,
    readonly target: BrowserTarget,
    /**
     * Interaction realism for this session (default `human`). Applied below the
     * tool surface: navigate dwells, fill types keystroke-by-keystroke, click
     * settles. `fast` is the raw opt-out; `stealth` adds an anti-bot wall check.
     */
    private readonly behavior: BehaviorProfile = "human"
  ) {}

  async navigate(options: NavigateOptions): Promise<void> {
    await this.provider.navigate(this.sessionId, options.url, {
      waitUntil: mapWaitUntil(options.waitUntil),
      timeout: options.timeoutMs,
    })
    // A human doesn't act the instant the page loads — pace before the caller's
    // next tool call (no-op under `fast`).
    const dwell = navDwellMs(this.behavior)
    if (dwell > 0) await sleep(dwell)
    // `stealth` surfaces an anti-bot wall instead of letting the caller read an
    // empty challenge page and report "0 results".
    if (this.behavior === "stealth" && (await this.isBlocked())) {
      throw new Error(
        `camofox driver: navigation to ${options.url} hit an anti-bot wall (stealth profile)`
      )
    }
  }

  /** Best-effort anti-bot wall check via the shared detector (stealth only). */
  private async isBlocked(): Promise<boolean> {
    const r = await this.provider
      .executeScript<boolean>(
        this.sessionId,
        `return ${BLOCKED_PAGE_EXPRESSION};`
      )
      .catch(() => ({ value: false }) as { value?: boolean })
    return r.value === true
  }

  async evaluate<T = unknown>(
    options: EvaluateOptions
  ): Promise<EvaluateResult<T>> {
    // Camofox has no CDP Runtime.evaluate, but the service's /evaluate runs
    // Playwright `page.evaluate` server-side. executeScript wraps the body in
    // an IIFE (function-body convention), so a CDP-style expression is returned
    // explicitly; parens keep multi-line/object-literal expressions valid.
    const result = await this.provider.executeScript<T>(
      this.sessionId,
      `return (${options.expression});`
    )
    if (result.error) {
      throw new Error(`camofox driver: evaluate failed: ${result.error}`)
    }
    // The service doesn't cap result size; signal truncation to honor the
    // port contract without corrupting the already-deserialized value.
    const truncated =
      JSON.stringify(result.value ?? null).length > options.maxResultBytes
    return { value: result.value, truncated }
  }

  async click(options: ClickOptions): Promise<void> {
    await this.provider.click(this.sessionId, options.selector)
    // Anti-bot heuristics flag back-to-back actions; settle before the next one.
    const settle = actionSettleMs(this.behavior)
    if (settle > 0) await sleep(settle)
  }

  async fill(options: FillOptions): Promise<void> {
    // `human`/`stealth` type keystroke-by-keystroke with jitter (the service
    // does the per-key delay); `fast` sets the value in one shot.
    await this.provider.type(
      this.sessionId,
      options.selector,
      options.value,
      typingOptions(this.behavior)
    )
  }

  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    // Camofox captures the viewport only — it can't do full-page stitching
    // (capabilities.canRecordVideo aside, the provider sets
    // supportsFullPageScreenshot:false). Fail loudly rather than silently
    // returning a viewport crop labeled as a full-page shot.
    if (options.fullPage) {
      NOT_SUPPORTED("full-page screenshot (Camofox captures viewport only)")
    }
    // Forward format/quality so the provider actually transcodes via sharp —
    // it only post-processes when clip||format||quality is set. Without this
    // the driver stamped options.format onto raw, untranscoded bytes.
    const buf = await this.provider.getScreenshot(this.sessionId, {
      selector: options.selector,
      format: options.format,
      quality: options.quality,
    })
    return {
      base64: buf.toString("base64"),
      format: options.format,
      width: 0, // the service doesn't return dimensions
      height: 0,
    }
  }

  async getDom(selector?: string): Promise<string> {
    // The Camofox provider's getContent() returns an ACCESSIBILITY snapshot,
    // not serialized HTML — feeding that to readability/cheerio breaks. The
    // port contract for getDom is the real outerHTML, so fetch it via the
    // service's /evaluate endpoint instead.
    const expression = selector
      ? `const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.outerHTML : "";`
      : `return document.documentElement.outerHTML;`
    const result = await this.provider.executeScript<string>(
      this.sessionId,
      expression
    )
    if (result.error) {
      throw new Error(`camofox driver: getDom failed: ${result.error}`)
    }
    return typeof result.value === "string" ? result.value : ""
  }

  async listRequests(): Promise<NetworkRequestSummary[]> {
    return NOT_SUPPORTED("listRequests")
  }

  async getRequestBody(): Promise<{ body: string; base64Encoded: boolean }> {
    return NOT_SUPPORTED("getRequestBody")
  }

  async send<TResult = unknown>(_command: CDPCommand): Promise<TResult> {
    return NOT_SUPPORTED("send (raw CDP)")
  }

  onEvent(_method: string, _listener: CDPEventListener): Unsubscribe {
    // Camofox doesn't relay CDP events — no-op subscription.
    return () => {}
  }

  async setCookies(
    cookies: readonly CookieJson[]
  ): Promise<{ injected: number }> {
    // "browse-as-the-user": inject a bridged jar (e.g. from the logged-in
    // Chrome session) so a stealth capture runs authenticated.
    await this.provider.setCookies(this.sessionId, [...cookies])
    return { injected: cookies.length }
  }

  async getCookies(): Promise<CookieJson[]> {
    // The camofox service exposes set-only cookie injection — there's no
    // export endpoint. camofox is a bridge TARGET, not a source.
    return NOT_SUPPORTED("getCookies (camofox is receive-only)")
  }

  async getRecordedVideo(): Promise<RecordedVideo> {
    const buf = await this.provider.getRecordedVideo(this.sessionId)
    return { base64: buf.toString("base64"), mimeType: "video/webm" }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.provider.closeSession(this.sessionId)
  }
}

export class CamofoxDriverProvider implements BrowserDriverProvider {
  readonly kind = "camofox" as const
  readonly capabilities = CAMOFOX_CAPABILITIES
  private readonly provider: CamofoxClient

  constructor(options: CamofoxDriverProviderOptions) {
    this.provider = options.client
  }

  async attach(options: AttachOptions): Promise<BrowserDriver> {
    const session = await this.provider.createSession()
    // Browse-as-the-user: inject the synced session cookies up front.
    // sessionPayload is foreign (decrypted BrowserSessionPayload), so validate
    // the cookies through the real CookieJson schema instead of casting.
    const parsed = ATTACH_PAYLOAD_SCHEMA.safeParse(options.sessionPayload)
    const cookies: CookieJson[] = parsed.success
      ? (parsed.data.cookies ?? [])
      : []
    if (cookies.length > 0) {
      await this.provider.setCookies(session.id, cookies)
    }
    if (options.initialUrl) {
      await this.provider.navigate(session.id, options.initialUrl, {
        waitUntil: "load",
      })
    }
    return new CamofoxDriver(
      this.provider,
      session.id,
      { id: session.id, url: options.initialUrl },
      resolveBehavior(options.behavior)
    )
  }

  async listTargets(): Promise<BrowserTarget[]> {
    // Camofox tabs are addressed per session; no global enumeration endpoint.
    return []
  }
}

/** Register the Camofox backend into a BrowserDriverRegistry. */
export function registerCamofoxDriver(
  registry: BrowserDriverRegistry,
  options: CamofoxDriverProviderOptions
): CamofoxDriverProvider {
  const provider = new CamofoxDriverProvider(options)
  registry.register(provider)
  return provider
}

export {
  BLOCKED_PAGE_EXPRESSION,
  sleep,
  jitter,
  navDwellMs,
  actionSettleMs,
  typingOptions,
} from "./behavior.js"
export type { BehaviorProfile } from "@agentproto/bureau-core/driver"
export { createCamofoxRestClient } from "./client.js"
export type {
  CamofoxClient,
  CamofoxRestClientConfig,
  CamofoxNavigateOptions,
  CamofoxScreenshotOptions,
  CamofoxScriptResult,
  CamofoxTypeOptions,
} from "./client.js"
