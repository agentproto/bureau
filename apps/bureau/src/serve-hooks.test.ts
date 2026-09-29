import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createCamofoxHarness, type CamofoxHarness } from "./__tests__/support/browser-fakes.js"
import { rawRequest, mcpCall } from "./__tests__/support/http.js"
import { licenseCanary, newLicenseKeys, signLicense } from "./__tests__/support/license-signer.js"
import { bootServe, healthOf, loopbackPlugin, registryOver, tempHome, type Booted, type TempHome } from "./__tests__/support/serve-harness.js"
import { createLicenseCheck } from "./lib/license.js"
import { createOfflineRegistry } from "./lib/pairing.js"
import type { BrowserUsageEvent, BureauPlugin } from "./plugin.js"

let tmp: TempHome
let booted: Booted | undefined
let camofox: CamofoxHarness | undefined

beforeEach(() => {
  tmp = tempHome()
})
afterEach(async () => {
  await booted?.handle.close().catch(() => {})
  booted = undefined
  await camofox?.dispose()
  camofox = undefined
  tmp.cleanup()
})

const keys = newLicenseKeys()
const nowSec = (): number => Math.floor(Date.now() / 1000)
const proTool = { name: "pro_tool", description: "pro", jsonSchema: { type: "object" as const, properties: {} }, call: async () => ({ content: [{ type: "text" as const, text: "pro" }] }) }

const licensed = (token: string | undefined): BureauPlugin => ({
  name: "pro",
  entries: () => [proTool],
  license: createLicenseCheck({ publicKey: keys.publicKey, token }),
})

const toolNames = async (port: number, bearer?: string): Promise<string[]> => {
  const r = await mcpCall(port, "tools/list", {}, bearer)
  const body = JSON.parse(r.body) as { result: { tools: Array<{ name: string }> } }
  return body.result.tools.map(t => t.name)
}

describe("pro license at plugin load", () => {
  const liveCases: Array<[string, string | undefined, RegExp]> = [
    ["expired", signLicense(keys, { sub: "canary-license-holder", exp: nowSec() - 60, features: ["pro"] }), /expired/],
    ["tampered", (() => {
      const [h, , s] = licenseCanary(keys, nowSec() + 3600).split(".") as [string, string, string]
      return `${h}.${Buffer.from(JSON.stringify({ sub: "x", exp: nowSec() + 10 ** 9, features: ["pro"] })).toString("base64url")}.${s}`
    })(), /does not verify/],
    ["unsigned", licenseCanary(keys, nowSec() + 3600).split(".").slice(0, 2).join("."), /unsigned/],
    ["missing", undefined, /no license token/],
  ]

  for (const [label, token, reason] of liveCases) {
    it(`refuses a plugin with a ${label} license, says why, and the core keeps serving`, async () => {
      booted = await bootServe({ argv: ["--no-browser"], home: tmp.home, plugins: [loopbackPlugin, licensed(token)] })
      const { status, body } = await healthOf(booted.port)
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      const extras = body as unknown as { licenseRefusals?: Array<{ plugin: string; reason: string }> }
      expect(extras.licenseRefusals).toHaveLength(1)
      expect(extras.licenseRefusals?.[0]?.plugin).toBe("pro")
      expect(extras.licenseRefusals?.[0]?.reason).toMatch(reason)
      const logged = booted.logs.join("\n")
      expect(logged).toMatch(/license refused/)
      expect(logged).toMatch(reason)
      expect(booted.fatal).toEqual([])
      const names = await toolNames(booted.port)
      expect(names).toContain("browser_navigate")
      expect(names).not.toContain("pro_tool")
      if (token) {
        for (const text of [logged, JSON.stringify(body)]) {
          expect(text).not.toContain(token)
          expect(text).not.toContain(token.split(".")[1] ?? "zz")
        }
      }
    })
  }

  it("loads a plugin whose license is valid, and adds no health field", async () => {
    const token = licenseCanary(keys, nowSec() + 3600)
    booted = await bootServe({ argv: ["--no-browser"], home: tmp.home, plugins: [loopbackPlugin, licensed(token)] })
    expect(await toolNames(booted.port)).toContain("pro_tool")
    const { body } = await healthOf(booted.port)
    expect(Object.keys(body)).not.toContain("licenseRefusals")
    expect(booted.logs.join("\n")).not.toContain(token)
  })

  it("never blocks a plugin that has no license requirement", async () => {
    const free: BureauPlugin = { name: "free", entries: () => [proTool] }
    booted = await bootServe({ argv: ["--no-browser"], home: tmp.home, plugins: [loopbackPlugin, free] })
    expect(await toolNames(booted.port)).toContain("pro_tool")
    expect(booted.logs.join("\n")).not.toMatch(/license/)
  })

  it("never blocks the OSS core with no plugin at all", async () => {
    booted = await bootServe({ argv: ["--no-browser"], home: tmp.home, plugins: [] })
    const { status, body } = await healthOf(booted.port)
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(Object.keys(body)).not.toContain("licenseRefusals")
    expect(booted.logs.join("\n")).not.toMatch(/license/)
  })
})

describe("session lease tools by flavour", () => {
  it("the OSS pairing flavour lists session_lease and session_lease_revoke for a paired device", async () => {
    const dev = await createOfflineRegistry(tmp.home).mintLocalDevice({ name: "cc" })
    booted = await bootServe({ argv: ["--no-browser"], home: tmp.home, plugins: [] })
    expect((await mcpCall(booted.port, "tools/list", {})).status).toBe(401)
    const names = await toolNames(booted.port, dev.bearer)
    expect(names).toContain("session_lease")
    expect(names).toContain("session_lease_revoke")
    const denied = await mcpCall(booted.port, "tools/call", { name: "session_lease", arguments: { session: "s", domains: ["example.com"] } }, dev.bearer)
    expect(denied.body).toContain("approval_required")
    const ledger = join(tmp.home, "lease-ledger.jsonl")
    expect(existsSync(ledger)).toBe(true)
    if (process.platform !== "win32") expect(statSync(ledger).mode & 0o777).toBe(0o600)
  })

  it("the studio flavour (authorize: allowLoopback) has no consent host, so no lease tools", async () => {
    booted = await bootServe({ argv: ["--no-browser"], home: tmp.home })
    const names = await toolNames(booted.port)
    expect(names).not.toContain("session_lease")
    expect(names).not.toContain("session_lease_revoke")
    expect((await rawRequest(booted.port, "GET", "/health")).status).toBe(200)
  })
})

describe("usage metering at the supervisor lifecycle", () => {
  const rows = (path: string): BrowserUsageEvent[] =>
    readFileSync(path, "utf8").trim().split("\n").map(l => JSON.parse(l) as BrowserUsageEvent)

  it("writes start and stop rows to --usage-file (0600) and nothing else", async () => {
    camofox = await createCamofoxHarness("ok")
    const file = join(tmp.home, "usage.jsonl")
    booted = await bootServe({ argv: ["--camofox-cmd", "fake-camofox serve", "--usage-file", file], registry: registryOver(camofox.provider), home: tmp.home })
    await booted.handle.browserReady
    expect(rows(file).map(r => `${r.type}:${r.scope}`)).toEqual(["start:instance"])
    await booted.handle.close()
    booted = undefined
    const all = rows(file)
    expect(all.map(r => `${r.type}:${r.scope}`)).toEqual(["start:instance", "stop:instance"])
    expect(all.every(r => r.browser === "camofox")).toBe(true)
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, "utf8")).not.toMatch(/http|cookie|token/i)
  })

  it("emits nothing by default (noop meter)", async () => {
    camofox = await createCamofoxHarness("ok")
    booted = await bootServe({ argv: ["--camofox-cmd", "fake-camofox serve"], registry: registryOver(camofox.provider), home: tmp.home })
    await booted.handle.browserReady
    await booted.handle.close()
    booted = undefined
    expect(existsSync(join(tmp.home, "usage.jsonl"))).toBe(false)
  })

  it("a plugin can supply its own meter, which wins over the file sink", async () => {
    camofox = await createCamofoxHarness("ok")
    const events: BrowserUsageEvent[] = []
    const meterPlugin: BureauPlugin = { name: "meter", entries: () => [], usage: { record: () => {}, browser: e => void events.push(e) } }
    const file = join(tmp.home, "usage.jsonl")
    booted = await bootServe({
      argv: ["--camofox-cmd", "fake-camofox serve", "--usage-file", file],
      registry: registryOver(camofox.provider),
      home: tmp.home,
      plugins: [loopbackPlugin, meterPlugin],
    })
    await booted.handle.browserReady
    await booted.handle.close()
    booted = undefined
    expect(events.map(e => `${e.type}:${e.scope}`)).toEqual(["start:instance", "stop:instance"])
    expect(existsSync(file)).toBe(false)
  })

  it("rejects a heartbeat interval that is not a positive whole number", async () => {
    await expect(bootServe({ argv: ["--no-browser", "--usage-heartbeat-ms", "0"], home: tmp.home })).rejects.toThrow(/usage-heartbeat-ms/)
  })
})
