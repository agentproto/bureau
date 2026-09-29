/**
 * MCP BrowserDriver backend — drives ANY external MCP browser server through the
 * unified BrowserDriver port. Generalizes the tunnel pattern (forward each
 * method as a `tools/call`) to an arbitrary transport + a tool-name map.
 *
 * With the canonical `browser_*` names it speaks to our own @agentproto/bureau-mcp
 * (remote, hosted by apps/service) and a connect extension server. A
 * different `toolNames` map points it at a foreign server (e.g. chrome-devtools-mcp
 * imported via the agentproto daemon). Foreign servers whose argument shapes
 * differ from the canonical ones need a binding that also adapts args — the
 * name map alone assumes canonical argument shapes.
 */

import {
  networkRequestSummarySchema,
  type AttachOptions,
  type BrowserDriver,
  type BrowserDriverCapabilities,
  type BrowserDriverProvider,
  type BrowserTarget,
  type CDPCommand,
  type CDPEventListener,
  type ClickOptions,
  type EvaluateOptions,
  type EvaluateResult,
  type FillOptions,
  type NavigateOptions,
  type NetworkRequestSummary,
  type ScreenshotOptions,
  type ScreenshotResult,
  type Unsubscribe,
} from "@agentproto/bureau-core/driver"
import { z } from "zod"
import type { BrowserDriverRegistry } from "../index.js"

// Foreign MCP servers return arbitrary JSON. Validate the shapes we depend on
// before reading fields so a contract mismatch surfaces as a clear zod error
// instead of a cryptic `undefined.html` / `.requests` crash downstream.
const getDomResultSchema = z.object({ html: z.string() }).loose()
const listRequestsResultSchema = z
  .object({ requests: z.array(networkRequestSummarySchema) })
  .loose()
const requestBodyResultSchema = z
  .object({ body: z.string(), base64Encoded: z.boolean() })
  .loose()
const evaluateResultSchema = z
  .object({ value: z.unknown(), truncated: z.boolean() })
  .loose()

/** Invoke a tool on the MCP server and resolve with the parsed JSON result. */
export type McpCallTool = (
  name: string,
  args: Record<string, unknown>
) => Promise<unknown>

/** Tool names per BrowserDriver method. Defaults to the canonical `browser_*` set. */
export interface McpToolNames {
  navigate: string
  evaluate: string
  click: string
  fill: string
  screenshot: string
  getDom: string
  listRequests: string
  getRequestBody: string
  cdpSend: string
}

export const CANONICAL_TOOL_NAMES: McpToolNames = {
  navigate: "browser_navigate",
  evaluate: "browser_evaluate",
  click: "browser_click",
  fill: "browser_fill",
  screenshot: "browser_screenshot",
  getDom: "browser_get_dom",
  listRequests: "browser_list_requests",
  getRequestBody: "browser_get_request_body",
  cdpSend: "browser_cdp_send",
}

const MCP_DEFAULT_CAPABILITIES: BrowserDriverCapabilities = {
  canCaptureResponseBodies: true,
  canDispatchTrustedInput: true,
  canMultiTarget: false,
  canThrottleNetwork: false,
  isUserVisible: false,
  canScreencast: false,
  canRecordVideo: false,
  canStealth: false,
  canAiActions: false,
  canFullPageScreenshot: true, // passthrough default; override via binding.capabilities if the wrapped server can't
}

export interface McpBrowserBinding {
  /** Transport: invoke a named tool, get back the parsed result. */
  callTool: McpCallTool
  /** Override tool names for a foreign server. Defaults to canonical `browser_*`. */
  toolNames?: Partial<McpToolNames>
  /** Declared capabilities of the backing server. */
  capabilities?: Partial<BrowserDriverCapabilities>
}

class McpBrowserDriver implements BrowserDriver {
  readonly kind = "mcp" as const
  readonly capabilities: BrowserDriverCapabilities
  closed = false

  private readonly call: McpCallTool
  private readonly names: McpToolNames

  constructor(
    binding: McpBrowserBinding,
    readonly target: BrowserTarget
  ) {
    this.call = binding.callTool
    this.names = { ...CANONICAL_TOOL_NAMES, ...binding.toolNames }
    this.capabilities = { ...MCP_DEFAULT_CAPABILITIES, ...binding.capabilities }
  }

  async navigate(options: NavigateOptions): Promise<void> {
    await this.call(this.names.navigate, { ...options })
  }

  async evaluate<T = unknown>(
    options: EvaluateOptions
  ): Promise<EvaluateResult<T>> {
    const raw = await this.call(this.names.evaluate, { ...options })
    const parsed = evaluateResultSchema.parse(raw)
    // `value` is genuinely opaque page data; the caller's T is its contract.
    return { value: parsed.value as T, truncated: parsed.truncated }
  }

  async click(options: ClickOptions): Promise<void> {
    await this.call(this.names.click, { ...options })
  }

  async fill(options: FillOptions): Promise<void> {
    await this.call(this.names.fill, { ...options })
  }

  async screenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
    return (await this.call(this.names.screenshot, {
      ...options,
    })) as ScreenshotResult
  }

  async getDom(selector?: string): Promise<string> {
    const r = getDomResultSchema.parse(
      await this.call(this.names.getDom, { selector })
    )
    return r.html
  }

  async listRequests(opts?: {
    since?: number
    limit?: number
  }): Promise<NetworkRequestSummary[]> {
    const r = listRequestsResultSchema.parse(
      await this.call(this.names.listRequests, opts ?? {})
    )
    return r.requests
  }

  async getRequestBody(
    requestId: string
  ): Promise<{ body: string; base64Encoded: boolean }> {
    const r = requestBodyResultSchema.parse(
      await this.call(this.names.getRequestBody, { requestId })
    )
    return { body: r.body, base64Encoded: r.base64Encoded }
  }

  async send<TResult = unknown>(command: CDPCommand): Promise<TResult> {
    return (await this.call(this.names.cdpSend, { ...command })) as TResult
  }

  onEvent(_method: string, _listener: CDPEventListener): Unsubscribe {
    // MCP tools are request/response — no event stream is relayed.
    return () => {}
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

export interface McpDriverProviderOptions extends McpBrowserBinding {
  /** Stable target id for the driver this provider hands out. */
  targetId?: string
}

export class McpBrowserDriverProvider implements BrowserDriverProvider {
  readonly kind = "mcp" as const
  readonly capabilities: BrowserDriverCapabilities

  constructor(private readonly options: McpDriverProviderOptions) {
    this.capabilities = { ...MCP_DEFAULT_CAPABILITIES, ...options.capabilities }
  }

  async attach(options: AttachOptions): Promise<BrowserDriver> {
    const driver = new McpBrowserDriver(this.options, {
      id: options.targetId ?? this.options.targetId ?? "mcp",
      url: options.initialUrl,
    })
    if (options.initialUrl) {
      await driver.navigate({ url: options.initialUrl, waitUntil: "load" })
    }
    return driver
  }

  async listTargets(): Promise<BrowserTarget[]> {
    return []
  }
}

/** Register an external MCP browser server as the `mcp` kind in the registry. */
export function registerMcpDriver(
  registry: BrowserDriverRegistry,
  options: McpDriverProviderOptions
): McpBrowserDriverProvider {
  const provider = new McpBrowserDriverProvider(options)
  registry.register(provider)
  return provider
}
