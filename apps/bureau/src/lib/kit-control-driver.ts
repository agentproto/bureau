/**
 * Kit control drivers — bridge the driver-browser kit port
 * (`@agentproto/driver-browser` providers: chrome, chromium) into the
 * bureau-core `BrowserDriver` registry the control tools resolve through.
 *
 * Without this bridge the control catalogue (browser_navigate / evaluate /
 * screenshot / list_requests / …) is hard-bound to the camofox backend no
 * matter which browser Bureau supervises, so `bureau start --browser chrome`
 * answered CDP questions with "camofox driver: listRequests is not supported".
 * With it, the active provider's manifest decides (`cdp: chrome=true,
 * camofox=false`) — the same table the capability gate reports from.
 */

import type {
  AttachOptions,
  BrowserDriver,
  BrowserDriverKind,
  BrowserDriverProvider,
  BrowserDriverCapabilities,
  BrowserTarget,
} from "@agentproto/bureau-core/driver"
import {
  type BrowserDriver as KitBrowserDriver,
} from "@agentproto/driver-browser"

/**
 * The kit providers Bureau can attach to for tool driving. Camofox keeps its
 * own REST driver; chrome/chromium (and any kit third-party provider with
 * `attach`) come over this bridge.
 */
export function isKitControlBrowser(id: string): boolean {
  return id === "chrome" || id === "chromium"
}

/** The kit's per-driver "can*" flags, mapped onto the bureau-core port. */
export function kitControlCapabilities(
  capabilities: KitBrowserDriver["capabilities"]
): BrowserDriverCapabilities {
  return {
    canCaptureResponseBodies: capabilities.canCaptureResponseBodies ?? false,
    canDispatchTrustedInput: capabilities.canDispatchTrustedInput ?? false,
    canMultiTarget: capabilities.canMultiTarget ?? false,
    canThrottleNetwork: capabilities.canThrottleNetwork ?? false,
    isUserVisible: capabilities.isUserVisible ?? false,
    canScreencast: capabilities.canScreencast ?? false,
    canRecordVideo: capabilities.canRecordVideo ?? false,
    canStealth: capabilities.canStealth ?? false,
    canFullPageScreenshot: capabilities.canFullPageScreenshot ?? false,
    canAiActions: capabilities.canAiActions ?? false,
    ...(capabilities.canCookies !== undefined
      ? { canCookies: capabilities.canCookies }
      : {}),
  }
}

/** Structure-typed shim: a kit `BrowserDriver` onto the bureau-core port. */
export class KitControlDriver implements BrowserDriver {
  readonly capabilities: BrowserDriverCapabilities
  private readonly _kind: BrowserDriverKind

  constructor(kit: KitBrowserDriver, expectedKind: BrowserDriverKind) {
    if (kit.kind !== expectedKind) {
      throw new Error(
        `kit control driver: expected kind "${expectedKind}", the driver reports "${kit.kind}"`
      )
    }
    this._kind = expectedKind
    this.capabilities = kitControlCapabilities(kit.capabilities)
    this.kit = kit
  }

  private readonly kit: KitBrowserDriver

  get kind(): BrowserDriverKind {
    return this._kind
  }

  get target(): BrowserTarget {
    return this.kit.target
  }

  get closed(): boolean {
    return this.kit.closed
  }

  navigate(options: Parameters<KitBrowserDriver["navigate"]>[0]): Promise<void> {
    return this.kit.navigate(options)
  }

  evaluate<T = unknown>(
    options: Parameters<KitBrowserDriver["evaluate"]>[0]
  ): Promise<{ value: T | undefined; truncated: boolean }> {
    return this.kit.evaluate<T>(options)
  }

  click(options: Parameters<KitBrowserDriver["click"]>[0]): Promise<void> {
    return this.kit.click(options)
  }

  fill(options: Parameters<KitBrowserDriver["fill"]>[0]): Promise<void> {
    return this.kit.fill(options)
  }

  screenshot(
    options: Parameters<KitBrowserDriver["screenshot"]>[0]
  ): ReturnType<KitBrowserDriver["screenshot"]> {
    return this.kit.screenshot(options)
  }

  getDom(selector?: string): Promise<string> {
    return this.kit.getDom(selector)
  }

  listRequests(opts?: {
    since?: number
    limit?: number
  }): ReturnType<KitBrowserDriver["listRequests"]> {
    return this.kit.listRequests(opts)
  }

  getRequestBody(
    requestId: string
  ): ReturnType<KitBrowserDriver["getRequestBody"]> {
    return this.kit.getRequestBody(requestId)
  }

  send<TResult = unknown>(command: {
    method: string
    params?: unknown
  }): Promise<TResult> {
    return this.kit.send<TResult>(command)
  }

  onEvent(
    method: string,
    listener: (event: { method: string; params: unknown }) => void
  ): () => void {
    return this.kit.onEvent(method, listener)
  }

  close(): Promise<void> {
    return this.kit.close()
  }
}

export interface KitControlDriverOptions {
  /** The bureau-core registry kind to register under. */
  kind: "chrome" | "chromium"
  /** Page-level capabilities the attached driver reports (from the adapter). */
  capabilities: BrowserDriverCapabilities
  /** Attach to the supervised kit instance's page driver. */
  attach: () => Promise<KitBrowserDriver>
}

/**
 * A bureau-core `BrowserDriverProvider` that resolves through the kit provider
 * Bureau already supervises: `launch` is idempotent per profile dir, so an
 * attach after the supervisor's launch reuses the same browser. One shim per
 * attach call; the toolkit's per-kind cache keeps it to one tab.
 */
export function createKitControlDriverProvider(
  options: KitControlDriverOptions
): BrowserDriverProvider {
  return {
    kind: options.kind,
    capabilities: options.capabilities,
    async listTargets(): Promise<BrowserTarget[]> {
      return []
    },
    async attach(_options: AttachOptions): Promise<BrowserDriver> {
      return new KitControlDriver(await options.attach(), options.kind)
    },
  }
}
