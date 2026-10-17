/**
 * The control-tool bridge: a supervised kit browser (chrome/chromium — and
 * their manifest `cdp` flags) must drive the browser_* catalogue itself, not
 * answer with camofox error strings. Follows the L2a fake-provider pattern:
 * `createFakeBrowserProvider` drivers, no real browser anywhere.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createFakeBrowserProvider } from "@agentproto/driver-browser"
import type { BrowserProvider, BrowserRegistry } from "@agentproto/driver-browser"
import type { McpEntry } from "./mcp-tool.js"
import { createKitControlDriverProvider, kitControlCapabilities, isKitControlBrowser } from "./lib/kit-control-driver.js"
import {
  createControlDriverRegistry,
  createCamofoxClient,
  createKitControlProvider,
  supportsKitControlDriver,
} from "./lib/browser-registry.js"
import {
  bootServe,
  loopbackPlugin,
  registryOver,
  tempHome,
  type Booted,
  type TempHome,
} from "./__tests__/support/serve-harness.js"
import { mcpCall } from "./__tests__/support/http.js"
import { healthOf } from "./__tests__/support/serve-harness.js"
import { buildCatalogue } from "./serve.js"

function expectBrowserDriverProvider(provider: unknown): void {
  const p = provider as { kind?: string; attach?: unknown }
  expect(p.kind).toBe("chrome")
  expect(typeof p.attach).toBe("function")
}

describe("kit control browser ids", () => {
  it("chrome and chromium drive tools through the kit port; camofox keeps its REST driver", () => {
    expect(isKitControlBrowser("chrome")).toBe(true)
    expect(isKitControlBrowser("chromium")).toBe(true)
    expect(isKitControlBrowser("camofox")).toBe(false)
    expect(isKitControlBrowser("acme-browser")).toBe(false)
  })
})

describe("capability mapping", () => {
  it("maps the manifest truth onto the driver port (chrome cdp=true, camofox cdp=false)", () => {
    const chromeCandy = createFakeBrowserProvider({ id: "chrome" }).provider.capabilities
    expect(kitControlCapabilities(chromeCandy)).toMatchObject({ canCaptureResponseBodies: true })
    const { provider: noCdp } = createFakeBrowserProvider({ id: "chrome", capabilities: { cdp: false } })
    expect(supportsKitControlDriver(noCdp)).toBe(false)
    expect(supportsKitControlDriver(createFakeBrowserProvider({ id: "chrome" }).provider)).toBe(true)
  })
})

describe("kit control driver provider", () => {
  it("attaches through the supervised kit instance and answers CDP tools with kit data", async () => {
    const { provider, state } = createFakeBrowserProvider({ id: "chrome" })
    const bridge: unknown = createKitControlProvider({ provider, launchOptions: {} })
    expectBrowserDriverProvider(bridge)
    const chromeBridge = bridge as NonNullable<ReturnType<typeof createKitControlProvider>>
    const driver = await chromeBridge.attach({})
    const requests = await driver.listRequests()
    expect(Array.isArray(requests)).toBe(true)
    await driver.navigate({ url: "https://example.com", waitUntil: "load" })
    expect((await driver.listRequests()).length).toBe(1)
    expect((await driver.getDom()).length).toBeGreaterThan(0)
    // Idempotent kit launch: the second attach reuses the same instance.
    await chromeBridge.attach({})
    expect(state.launches).toBe(1)
  })

  it("is refused for a browser that lacks the cdp capability", () => {
    const { provider } = createFakeBrowserProvider({ id: "chrome", capabilities: { cdp: false } })
    expect(createKitControlProvider({ provider })).toBeUndefined()
  })

  it("is refused for camofox, which drives tools through its REST client", () => {
    const camofox: BrowserProvider = createFakeBrowserProvider({ id: "camofox" }).provider
    expect(supportsKitControlDriver(camofox)).toBe(false)
  })
})

describe("control driver registry", () => {
  it("resolves the chrome kind through the kit bridge without touching the camofox client", async () => {
    const { provider } = createFakeBrowserProvider({ id: "chrome" })
    const camofox = createCamofoxClient("main")
    const registry = createControlDriverRegistry(camofox)
    const bridge = createKitControlProvider({ provider, launchOptions: {} })
    if (!bridge) throw new Error("chrome must bridge")
    registry.register(bridge)
    expect(registry.get("chrome")).toBeDefined()
    const driver = await registry.get("chrome")!.attach({})
    await driver.navigate({ url: "https://bureau.example/one", waitUntil: "load" })
    expect(await driver.listRequests()).toHaveLength(1)
  })
})

describe("tool catalogue on a chrome serve", () => {
  let tmp: TempHome
  let booted: Booted | undefined

  beforeEach(() => {
    tmp = tempHome()
  })
  afterEach(async () => {
    await booted?.handle.close().catch(() => {})
    booted = undefined
    tmp.cleanup()
  })

  const firstEntry = (entries: McpEntry[], name: string): McpEntry => {
    const entry = entries.find(e => e.name === name)
    if (!entry) throw new Error(`tool ${name} not in catalogue`)
    return entry
  }

  it("browser_list_requests runs in-process against the kit driver (no camofox error)", async () => {
    const { provider, state } = createFakeBrowserProvider({ id: "chrome" })
    const browsers: BrowserRegistry = registryOver(provider)
    const catalogue = buildCatalogue({
      browsers,
      browser: browsers.require("chrome"),
      launchOptions: {},
    })
    await firstEntry(catalogue.entries, "browser_list_requests").call({})
    expect(state.launches).toBe(1)
  })

  it("a camofox serve gates browser_list_requests with a typed cdp error, not a camofox error string", async () => {
    const { createCamofoxHarness } = await import("./__tests__/support/browser-fakes.js")
    const harness = await createCamofoxHarness("ok")
    try {
      booted = await bootServe({
        argv: ["--camofox-cmd", "fake-camofox serve"],
        registry: registryOver(harness.provider),
        home: tmp.home,
      })
      await booted.handle.browserReady
      const res = await mcpCall(booted.port, "tools/call", {
        name: "browser_list_requests",
        arguments: {},
      })
      expect(res.body).toContain("cdp")
      expect(res.body).toContain('browser_list_requests')
      expect(res.body).not.toContain("camofox driver: listRequests is not supported")
    } finally {
      await harness.dispose()
    }
  })

  it("serves the cdp tools on chrome and answers browser_list_requests over MCP", async () => {
    const chrome = createFakeBrowserProvider({ id: "chrome" })
    booted = await bootServe({
      argv: ["--browser", "chrome", "--profile", "work"],
      registry: registryOver(chrome.provider),
      home: tmp.home,
      plugins: [loopbackPlugin],
    })
    await booted.handle.browserReady
    const body = JSON.parse(
      (
        await mcpCall(booted.port, "tools/call", {
          name: "browser_list_requests",
          arguments: {},
        })
      ).body
    ) as { result?: { content?: Array<{ text?: string }> } }
    const text = body.result?.content?.[0]?.text ?? ""
    expect(text).toContain('"requests"')
    expect(text).not.toContain("camofox driver")
    expect(text).not.toContain("not supported")
    const { body: health } = await healthOf(booted.port)
    expect(health).toMatchObject({ browser: "chrome", state: "healthy" })
  })
})
