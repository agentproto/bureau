import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  BROWSER_CAPABILITY_NAMES,
  BROWSER_UNSUPPORTED_CODE,
  createBrowserRegistry,
  createFakeBrowserProvider,
  hasCapability,
  type BrowserCapabilityName,
  type BrowserProvider,
} from "@agentproto/driver-browser"
import type { McpEntry } from "../mcp-tool.js"
import { createBureauBrowserRegistry } from "./browser-registry.js"
import {
  CAPABILITY_TOOL_TABLE,
  alternativesFor,
  gateEntriesByCapability,
  toolCapabilityIndex,
  type CapabilityErrorBody,
} from "./capability-gate.js"

const here = dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(readFileSync(join(here, "..", "__tests__", "golden", "tool-catalogue.snapshot.json"), "utf8")) as {
  tools: Array<{ name: string }>
}
const goldenNames = new Set(golden.tools.map(t => t.name))

const entryFor = (name: string): McpEntry => ({
  name,
  description: `${name} tool`,
  jsonSchema: { type: "object", properties: {} },
  call: async () => ({ content: [{ type: "text", text: "ran" }] }),
})

const registry = createBureauBrowserRegistry()
const providers = registry.list()
const tableRows = Object.entries(CAPABILITY_TOOL_TABLE) as Array<[BrowserCapabilityName, readonly string[]]>

async function bodyOf(entry: McpEntry): Promise<CapabilityErrorBody> {
  const result = await entry.call({})
  expect(result.isError).toBe(true)
  const first = result.content[0]
  expect(first?.type).toBe("text")
  return JSON.parse((first as { text: string }).text) as CapabilityErrorBody
}

describe("capability table", () => {
  it("names only real capabilities and tools that exist in the catalogue", () => {
    expect(tableRows.length).toBeGreaterThan(0)
    for (const [capability, tools] of tableRows) {
      expect(BROWSER_CAPABILITY_NAMES).toContain(capability)
      for (const tool of tools) expect(goldenNames, `${tool} is not a catalogue tool`).toContain(tool)
    }
  })

  it("assigns each tool to one capability", () => {
    const all = tableRows.flatMap(([, tools]) => tools)
    expect(new Set(all).size).toBe(all.length)
    expect(toolCapabilityIndex().size).toBe(all.length)
  })

  it("walks table x providers: lacking the capability gives the typed error, having it passes through", async () => {
    let gated = 0
    let passed = 0
    for (const active of providers) {
      for (const [capability, tools] of tableRows) {
        const entries = tools.map(entryFor)
        const out = gateEntriesByCapability(entries, { active, registry })
        for (const [i, original] of entries.entries()) {
          const entry = out[i] as McpEntry
          if (hasCapability(active.capabilities, capability)) {
            expect(entry, `${original.name} on ${active.id}`).toBe(original)
            passed += 1
            continue
          }
          gated += 1
          expect(entry.name).toBe(original.name)
          expect(entry.jsonSchema).toEqual(original.jsonSchema)
          const body = await bodyOf(entry)
          expect(body.code).toBe(BROWSER_UNSUPPORTED_CODE)
          expect(body.tool).toBe(original.name)
          expect(body.capability).toBe(capability)
          expect(body.browser).toBe(active.id)
          expect(body.alternatives).toEqual(alternativesFor(registry, capability, active.id))
          expect(body.error).toContain(capability)
          expect(body.error).toContain(active.id)
          for (const alt of body.alternatives) expect(body.error).toContain(alt)
        }
      }
    }
    expect(gated).toBeGreaterThan(0)
    expect(passed).toBeGreaterThan(0)
  })

  it("keeps camofox, chrome and chromium on the documented capability split", () => {
    const by = (id: string): BrowserProvider => registry.require(id)
    expect(hasCapability(by("camofox").capabilities, "cdp")).toBe(false)
    expect(hasCapability(by("camofox").capabilities, "stealth")).toBe(true)
    expect(hasCapability(by("chrome").capabilities, "cdp")).toBe(true)
    expect(hasCapability(by("chromium").capabilities, "stealth")).toBe(false)
  })
})

describe("gate behaviour", () => {
  it("names the alternatives, and says so when there are none", async () => {
    const camofox = registry.require("camofox")
    const [cdpEntry] = gateEntriesByCapability([entryFor("browser_cdp_send")], { active: camofox, registry })
    const body = await bodyOf(cdpEntry as McpEntry)
    expect(body.alternatives).toEqual(["chrome", "chromium"])
    expect(body.error).toContain("bureau start --browser chrome | chromium")

    const alone = createBrowserRegistry([camofox])
    const [lonely] = gateEntriesByCapability([entryFor("browser_cdp_send")], { active: camofox, registry: alone })
    const lonelyBody = await bodyOf(lonely as McpEntry)
    expect(lonelyBody.alternatives).toEqual([])
    expect(lonelyBody.error).toContain("No registered browser has it")
  })

  it("leaves tools outside the table untouched", () => {
    const plain = entryFor("browser_navigate")
    const [out] = gateEntriesByCapability([plain], { active: registry.require("chromium"), registry })
    expect(out).toBe(plain)
  })

  it("gates by the manifest flag, so a third-party provider with cdp unlocks the CDP tools", async () => {
    const { provider: acmeCdp } = createFakeBrowserProvider({ id: "acme-cdp", capabilities: { cdp: true } })
    const { provider: acmePlain } = createFakeBrowserProvider({ id: "acme-plain", capabilities: { cdp: false } })
    const both = createBureauBrowserRegistry({ plugins: [{ name: "acme", entries: () => [], browsers: [acmeCdp, acmePlain] }] })
    const tool = entryFor("browser_cdp_send")
    expect(gateEntriesByCapability([tool], { active: acmeCdp, registry: both })[0]).toBe(tool)
    const body = await bodyOf(gateEntriesByCapability([tool], { active: acmePlain, registry: both })[0] as McpEntry)
    expect(body.browser).toBe("acme-plain")
    expect(body.alternatives).toContain("acme-cdp")
  })

  it("adds plugin tool capabilities to the table", async () => {
    const chromium = registry.require("chromium")
    const [gated] = gateEntriesByCapability([entryFor("acme_evade")], {
      active: chromium,
      registry,
      extra: { acme_evade: "stealth" },
    })
    const body = await bodyOf(gated as McpEntry)
    expect(body.capability).toBe("stealth")
    expect(body.alternatives).toEqual(["camofox"])
  })
})
