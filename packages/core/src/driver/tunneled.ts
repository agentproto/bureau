/**
 * `BrowserDriver` implementation that proxies all operations over a JSON-RPC
 * transport (a connect tunnel) to an `ExtensionBrowserMcpServer`
 * running inside the user's browser extension.
 *
 * Server-side bundles instantiate one of these per (conversation, browser
 * target) pair, passing a `sendRequest` function bound to the relevant
 * connectorId. All `BrowserDriver` methods forward as `tools/call` frames
 * with `name = "browser_<verb>"`.
 *
 * Capabilities mirror the extension impl (user-visible, response bodies,
 * trusted input) — same chrome.debugger backend under the hood.
 */

import type {
  BrowserDriver,
  BrowserDriverCapabilities,
  BrowserDriverKind,
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
import type { SupportsCookies } from "./capabilities.js"
import type { CookieJson } from "../session/types.js"

const TUNNELED_CAPABILITIES: BrowserDriverCapabilities = {
  canCaptureResponseBodies: true,
  canDispatchTrustedInput: true,
  canMultiTarget: false,
  canThrottleNetwork: true,
  isUserVisible: true,
  canScreencast: false,
  canRecordVideo: false,
  canStealth: false,
  canAiActions: false,
  canCookies: true, // CDP Network.getAllCookies/setCookies — reads HttpOnly (the bridge SOURCE)
  canFullPageScreenshot: true, // extension backend uses CDP captureBeyondViewport
}

/** Subset of a CDP Network.Cookie we map to the portable CookieJson. */
interface RawCdpCookie {
  name: string
  value: string
  domain: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: "Strict" | "Lax" | "None"
}

function toCookieJson(c: RawCdpCookie): CookieJson {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path ?? "/",
    ...(c.httpOnly != null ? { httpOnly: c.httpOnly } : {}),
    ...(c.secure != null ? { secure: c.secure } : {}),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    ...(c.expires != null && c.expires > 0 ? { expires: c.expires } : {}),
  }
}

/** Transport contract: send a JSON-RPC `tools/call` and resolve with the unwrapped result. */
export type TunneledSendRequest = (frame: {
  method: string
  params?: unknown
  timeoutMs?: number
}) => Promise<unknown>

export interface TunneledBrowserDriverOptions {
  target: BrowserTarget
  sendRequest: TunneledSendRequest
  /**
   * Override the driver kind. Defaults to "extension" (a connect
   * tunnel). A cloud Bureau passes its real backend kind (e.g. "camofox") so
   * callers report it honestly — the forwarding transport is identical.
   */
  kind?: BrowserDriverKind
  /**
   * Override capabilities. Defaults to the extension-flavoured set. A cloud
   * stealth daemon passes its own (canStealth, !isUserVisible, …) so
   * browserListBrowsers advises the agent correctly.
   */
  capabilities?: BrowserDriverCapabilities
}

export class TunneledBrowserDriver implements BrowserDriver, SupportsCookies {
  readonly kind: BrowserDriverKind
  readonly capabilities: BrowserDriverCapabilities
  readonly target: BrowserTarget

  private readonly sendRequest: TunneledSendRequest
  private _closed = false

  constructor(opts: TunneledBrowserDriverOptions) {
    this.target = opts.target
    this.sendRequest = opts.sendRequest
    this.kind = opts.kind ?? "extension"
    this.capabilities = opts.capabilities ?? TUNNELED_CAPABILITIES
  }

  get closed(): boolean {
    return this._closed
  }

  private async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>
  ): Promise<T> {
    const result = (await this.sendRequest({
      method: "tools/call",
      params: { name, arguments: args },
    })) as {
      content?: Array<{ type: string; text?: string }>
      isError?: boolean
    }
    // MCP signals tool failures via `isError` with the message in the text
    // block — surface it instead of JSON.parsing an error string as success.
    if (result.isError) {
      throw new Error(result.content?.[0]?.text ?? "tool call failed")
    }
    const text = result.content?.[0]?.text ?? "{}"
    return JSON.parse(text) as T
  }

  async navigate(options: NavigateOptions): Promise<void> {
    await this.callTool("browser_navigate", { ...options })
  }

  async evaluate<T = unknown>(
    options: EvaluateOptions
  ): Promise<EvaluateResult<T>> {
    return await this.callTool<EvaluateResult<T>>("browser_evaluate", {
      ...options,
    })
  }

  async click(options: ClickOptions): Promise<void> {
    await this.callTool("browser_click", { ...options })
  }

  async fill(options: FillOptions): Promise<void> {
    await this.callTool("browser_fill", { ...options })
  }

  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    return await this.callTool<ScreenshotResult>("browser_screenshot", {
      ...options,
    })
  }

  async getDom(selector?: string): Promise<string> {
    const r = await this.callTool<{ html: string }>("browser_get_dom", {
      selector,
    })
    return r.html
  }

  async listRequests(opts?: {
    since?: number
    limit?: number
  }): Promise<NetworkRequestSummary[]> {
    const r = await this.callTool<{ requests: NetworkRequestSummary[] }>(
      "browser_list_requests",
      opts ?? {}
    )
    return r.requests
  }

  async getRequestBody(
    requestId: string
  ): Promise<{ body: string; base64Encoded: boolean }> {
    return await this.callTool("browser_get_request_body", { requestId })
  }

  async send<TResult = unknown, TParams = unknown>(
    command: CDPCommand<TParams>
  ): Promise<TResult> {
    return await this.callTool<TResult>("browser_cdp_send", {
      method: command.method,
      params: command.params,
    })
  }

  // ---- Cookie export/import (SupportsCookies) — the bridge SOURCE ----
  // CDP reads HttpOnly cookies (auth_token etc.) that document.cookie can't.

  async getCookies(opts?: {
    domain?: string
    url?: string
  }): Promise<CookieJson[]> {
    const res = opts?.url
      ? await this.send<{ cookies?: RawCdpCookie[] }>({
          method: "Network.getCookies",
          params: { urls: [opts.url] },
        })
      : await this.send<{ cookies?: RawCdpCookie[] }>({
          method: "Network.getAllCookies",
        })
    const want = opts?.domain?.replace(/^\./, "").toLowerCase()
    return (res.cookies ?? [])
      .filter(
        c => !want || c.domain.replace(/^\./, "").toLowerCase().includes(want)
      )
      .map(toCookieJson)
  }

  async setCookies(
    cookies: readonly CookieJson[]
  ): Promise<{ injected: number }> {
    await this.send({
      method: "Network.setCookies",
      params: { cookies: [...cookies] },
    })
    return { injected: cookies.length }
  }

  onEvent(_method: string, _listener: CDPEventListener): Unsubscribe {
    // Push events from the extension are not relayed back through the tunnel
    // today (no notification-frame plumbing). Server-side consumers polling
    // listRequests() get the same data on demand.
    return () => {}
  }

  // ---- Browser-wide ops (provider-level on the extension side) ----
  // Forwarded as MCP tool calls; the extension's MCP server dispatches
  // to `provider.listTargets / openTab / focusTab` (chrome.tabs.* APIs)
  // — bypasses chrome.debugger, so it doesn't burn the per-tab debugger
  // slot just to enumerate or spawn tabs.

  async listTabs(): Promise<BrowserTarget[]> {
    const r = await this.callTool<{ tabs: BrowserTarget[] }>(
      "browser_list_tabs",
      {}
    )
    return r.tabs
  }

  async openTab(opts: {
    url?: string
    active?: boolean
  }): Promise<BrowserTarget> {
    const r = await this.callTool<{ tab: BrowserTarget }>("browser_open_tab", {
      ...opts,
    })
    return r.tab
  }

  async focusTab(tabId: string): Promise<BrowserTarget> {
    const r = await this.callTool<{ tab: BrowserTarget }>("browser_focus_tab", {
      tabId,
    })
    return r.tab
  }

  async close(): Promise<void> {
    this._closed = true
  }
}
