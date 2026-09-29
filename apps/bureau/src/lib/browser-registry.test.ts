import { describe, expect, it } from "vitest"
import { createFakeBrowserProvider } from "@agentproto/driver-browser"
import {
  createBureauBrowserRegistry,
  mapBackendHealth,
  normalizeBrowserId,
  requireBrowser,
} from "./browser-registry.js"
import { BrowserFlagError, browserFlagsFrom, chooseBrowserId, planBrowserLaunch } from "./browser-launch.js"

describe("browser registry", () => {
  it("registers camofox, chrome and chromium", () => {
    expect(
      createBureauBrowserRegistry()
        .list()
        .map(p => p.id)
        .sort()
    ).toEqual(["camofox", "chrome", "chromium"])
  })

  it("accepts camoufox and any case as camofox", () => {
    expect(normalizeBrowserId("Camoufox")).toBe("camofox")
    expect(requireBrowser(createBureauBrowserRegistry(), "camoufox").id).toBe("camofox")
  })

  it("selects a third-party provider registered through the plugin seam by id", () => {
    const { provider } = createFakeBrowserProvider({ id: "acme-browser" })
    const registry = createBureauBrowserRegistry({ plugins: [{ name: "acme", entries: () => [], browsers: [provider] }] })
    expect(requireBrowser(registry, "acme-browser")).toBe(provider)
    const plan = planBrowserLaunch({
      registry,
      id: chooseBrowserId(browserFlagsFrom({ browser: "acme-browser", headless: "true" }), {}),
      flags: browserFlagsFrom({ browser: "acme-browser", headless: "true" }),
    })
    expect(plan.provider.id).toBe("acme-browser")
    expect(plan.options.headless).toBe(true)
  })

  it("lists the registered ids when the id is unknown", () => {
    expect(() => requireBrowser(createBureauBrowserRegistry(), "netscape")).toThrow(/camofox/)
  })

  it("names the plugin when a provider id is already taken", () => {
    const { provider } = createFakeBrowserProvider({ id: "chrome" })
    expect(() => createBureauBrowserRegistry({ plugins: [{ name: "clash", entries: () => [], browsers: [provider] }] })).toThrow(
      /plugin "clash" cannot register browser "chrome"/
    )
  })
})

describe("launch planning", () => {
  const registry = createBureauBrowserRegistry()

  it("prefers --browser, then BUREAU_BROWSER, then the positional, then camofox", () => {
    expect(chooseBrowserId({ browser: "chrome" }, { BUREAU_BROWSER: "chromium" }, "camofox")).toBe("chrome")
    expect(chooseBrowserId({}, { BUREAU_BROWSER: "chromium" }, "camofox")).toBe("chromium")
    expect(chooseBrowserId({}, {}, "camoufox")).toBe("camofox")
    expect(chooseBrowserId({}, {})).toBe("camofox")
  })

  it("refuses --headless together with --headed", () => {
    expect(() => planBrowserLaunch({ registry, id: "chrome", flags: browserFlagsFrom({ headless: "true", headed: "true" }) })).toThrow(BrowserFlagError)
  })

  it("rejects a bad port and a bad timeout", () => {
    expect(() => browserFlagsFrom({ "browser-port": "99999" })).toThrow(/port/)
    expect(() => browserFlagsFrom({ timeout: "0" })).toThrow(/timeout/)
  })

  it("needs a recorded grant for --full-profile", () => {
    expect(() => planBrowserLaunch({ registry, id: "chrome", flags: browserFlagsFrom({ "full-profile": "grant-1" }) })).toThrow(BrowserFlagError)
    const plan = planBrowserLaunch({
      registry,
      id: "chrome",
      flags: browserFlagsFrom({ "full-profile": "grant-1" }),
      fullProfileProof: grantId => ({ grantId, isActive: () => true }),
    })
    expect(plan.options.fullProfileGrant?.grantId).toBe("grant-1")
  })

  it("points camofox at CAMOFOX_URL unless a browser port is given", () => {
    const viaEnv = planBrowserLaunch({ registry, id: "camofox", flags: {}, env: { CAMOFOX_URL: "http://127.0.0.1:9999" } })
    expect(viaEnv.options.baseUrl).toBe("http://127.0.0.1:9999")
    const viaPort = planBrowserLaunch({ registry, id: "camofox", flags: browserFlagsFrom({ "browser-port": "9400" }), env: { CAMOFOX_URL: "http://127.0.0.1:9999" } })
    expect(viaPort.options.port).toBe(9400)
  })
})

describe("backend health mapping", () => {
  it("maps 200, 503 crash-looping, and no answer", () => {
    expect(mapBackendHealth({ status: 200, body: { ok: true, engine: "camoufox", browserState: "running" } }).ok).toBe(true)
    const looping = mapBackendHealth({ status: 503, body: { ok: false, engine: "camoufox", browserState: "crash-looping" } })
    expect(looping.ok).toBe(false)
    expect(mapBackendHealth(null, new Error("ECONNREFUSED")).ok).toBe(false)
  })
})
