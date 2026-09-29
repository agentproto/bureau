/**
 * Core-only catalogue vs the recorded snapshot: the 15 default browser tools
 * plus the workflow engine's `bureau_workflow_list` / `bureau_workflow_run`,
 * and no `screen_*`. Each must match `golden/tool-catalogue.snapshot.json`
 * (name, input schema, description hash).
 */
import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { buildCatalogue } from "../serve.js"

const here = dirname(fileURLToPath(import.meta.url))
const snapshot = JSON.parse(
  readFileSync(join(here, "golden", "tool-catalogue.snapshot.json"), "utf8")
) as {
  toolCount: number
  health: { response: { ok: boolean; tools: number } }
  tools: Array<{
    name: string
    descriptionSha256: string
    descriptionLength: number
    inputSchema: unknown
  }>
}

const CORE_TOOLS = [
  "browser_act",
  "browser_cdp_send",
  "browser_click",
  "browser_download",
  "browser_evaluate",
  "browser_fill",
  "browser_get_dom",
  "browser_get_request_body",
  "browser_list_requests",
  "browser_navigate",
  "browser_screenshot",
  "bureau_sessions",
  "bureau_tabs",
  "bureau_workflow_list",
  "bureau_workflow_run",
  "scrape",
  "session_sync_from_chrome",
]

describe("core-only catalogue (serve.ts, no plugins) vs the recorded snapshot", () => {
  it("the snapshot itself has 17 tools", () => {
    expect(snapshot.toolCount).toBe(17)
    expect(snapshot.tools).toHaveLength(17)
  })

  it("registers exactly the 15 default tools plus the 2 workflow-engine tools", () => {
    const names = buildCatalogue().entries.map(e => e.name)
    expect([...names].sort()).toEqual(CORE_TOOLS)
    expect(names).toHaveLength(17)
  })

  it("registers no screen_* tool", () => {
    const names = buildCatalogue().entries.map(e => e.name)
    expect(names.filter(n => n.startsWith("screen_"))).toEqual([])
  })

  it("every core tool matches the snapshot: same name, description hash, and input schema", () => {
    const { entries } = buildCatalogue()
    const recorded = new Map(snapshot.tools.map(t => [t.name, t]))
    for (const actual of entries) {
      const expected = recorded.get(actual.name)
      expect(expected, `"${actual.name}" is not in the snapshot`).toBeDefined()
      const actualHash = createHash("sha256")
        .update(actual.description, "utf8")
        .digest("hex")
      expect(actualHash, `"${actual.name}" description changed`).toBe(
        expected!.descriptionSha256
      )
      expect(actual.jsonSchema, `"${actual.name}" input schema changed`).toEqual(
        expected!.inputSchema
      )
    }
  })

  it("GET /health shape (additive fields only) matches {ok:true, tools:N}", () => {
    expect(snapshot.health.response).toEqual({ ok: true, tools: 17 })
  })
})
