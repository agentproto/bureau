import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderConfigDiff, runInstallMcp } from "./install-mcp.js"

let tmp: string
let prevHome: string | undefined
let lines: string[]
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bureau-imcp-cli-"))
  prevHome = process.env.BUREAU_HOME
  process.env.BUREAU_HOME = join(tmp, "home")
  lines = []
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")))
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (prevHome === undefined) delete process.env.BUREAU_HOME
  else process.env.BUREAU_HOME = prevHome
  await rm(tmp, { recursive: true, force: true })
})

describe("bureau install-mcp (CLI)", () => {
  it("prints the redacted config diff once; a second run changes nothing and prints no diff", async () => {
    const configPath = join(tmp, "mcp.json")
    const args = ["--client", "cursor", "--config", configPath, "--url", "http://127.0.0.1:1/mcp"]

    expect(await runInstallMcp(args)).toBe(0)
    const afterFirst = await readFile(configPath, "utf8")
    const firstOut = lines.join("\n")
    expect(firstOut).toContain(`--- ${configPath}`)
    expect(firstOut).toMatch(/^\+ .*"bureau": \{/m)
    expect(firstOut).toContain("redacted")
    const bearer = (JSON.parse(afterFirst) as { mcpServers: { bureau: { headers: { Authorization: string } } } }).mcpServers
      .bureau.headers.Authorization.replace(/^Bearer /, "")
    expect(firstOut).not.toContain(bearer)
    expect(firstOut).not.toContain(bearer.split(".")[2] ?? "no-mac")

    lines.length = 0
    expect(await runInstallMcp(args)).toBe(0)
    expect(await readFile(configPath, "utf8")).toBe(afterFirst)
    expect(lines.join("\n")).toContain("nothing changed")
    expect(lines.join("\n")).not.toContain("---")
  })

  it("--rotate mints a fresh device and prints the diff again", async () => {
    const configPath = join(tmp, "mcp.json")
    const args = ["--client", "cursor", "--config", configPath, "--url", "http://127.0.0.1:1/mcp"]
    await runInstallMcp(args)
    const first = await readFile(configPath, "utf8")
    lines.length = 0
    await runInstallMcp([...args, "--rotate"])
    expect(await readFile(configPath, "utf8")).not.toBe(first)
    expect(lines.join("\n")).toContain("Revoked the previous device")
    expect(lines.join("\n")).toContain("--- ")
  })

  it("a changed URL is not idempotent: it re-pairs", async () => {
    const configPath = join(tmp, "mcp.json")
    const base = ["--client", "cursor", "--config", configPath]
    await runInstallMcp([...base, "--url", "http://127.0.0.1:1/mcp"])
    lines.length = 0
    await runInstallMcp([...base, "--url", "http://127.0.0.1:2/mcp"])
    expect(lines.join("\n")).not.toContain("nothing changed")
    expect(lines.join("\n")).toContain("127.0.0.1:2")
  })
})

describe("renderConfigDiff", () => {
  it("is empty for equal configs and marks added and removed lines", () => {
    expect(renderConfigDiff("p", { a: 1 }, { a: 1 })).toBe("")
    const d = renderConfigDiff("p", { a: 1, b: 2 }, { a: 1, b: 3 })
    expect(d).toContain("-   \"b\": 2")
    expect(d).toContain("+   \"b\": 3")
  })
})
