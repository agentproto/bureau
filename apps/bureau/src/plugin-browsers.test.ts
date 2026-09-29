import { describe, expect, it } from "vitest"
import { createFakeBrowserProvider } from "@agentproto/driver-browser"
import { pluginShapeProblem } from "./plugin.js"

const base = { name: "p", entries: () => [] }

describe("plugin browsers and toolCapabilities", () => {
  it("accepts a provider list and a capability map", () => {
    const { provider } = createFakeBrowserProvider({ id: "acme" })
    expect(pluginShapeProblem({ ...base, browsers: [provider], toolCapabilities: { acme_tool: "cdp" } })).toBeUndefined()
  })

  it("rejects malformed browsers", () => {
    expect(pluginShapeProblem({ ...base, browsers: "chrome" })).toMatch(/array/)
    expect(pluginShapeProblem({ ...base, browsers: [{ id: "x" }] })).toMatch(/launch/)
  })

  it("rejects an unknown capability", () => {
    expect(pluginShapeProblem({ ...base, toolCapabilities: { t: "telepathy" } })).toMatch(/not a browser capability/)
    expect(pluginShapeProblem({ ...base, toolCapabilities: [] })).toMatch(/object/)
  })
})
