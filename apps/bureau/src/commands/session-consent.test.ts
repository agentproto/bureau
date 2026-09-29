import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createAgentConsentSurface, createConsentLedger, fileGrantStore } from "@agentproto/browser-profiles"
import { cmdGrants, cmdImport, cmdRevoke, type SessionConsentDeps } from "./session-consent.js"
import { runSession } from "./session.js"
import { CANARY, consentPaths, fakeChromePort, makeHost, type FakeChrome } from "../__tests__/support/consent-fixture.js"

let home: string
let chrome: FakeChrome
let lines: string[]
let asked: string[]

const priorSessionsDir = process.env["BUREAU_SESSIONS_DIR"]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bureau-session-"))
  process.env["BUREAU_SESSIONS_DIR"] = join(home, "saved-sessions")
  chrome = fakeChromePort()
  lines = []
  asked = []
})
afterEach(() => {
  if (priorSessionsDir === undefined) delete process.env["BUREAU_SESSIONS_DIR"]
  else process.env["BUREAU_SESSIONS_DIR"] = priorSessionsDir
  rmSync(home, { recursive: true, force: true })
})

const deps = (over: Partial<SessionConsentDeps> = {}): SessionConsentDeps => ({
  home,
  interactive: false,
  log: l => lines.push(l),
  createHost: prompt => makeHost(home, chrome, prompt, () => new Date("2026-09-29T12:00:00.000Z")),
  now: () => new Date("2026-09-29T12:00:00.000Z"),
  ...over,
})

const output = (): string => lines.join("\n")
const ledgerText = (): string => (existsSync(consentPaths(home).ledger) ? readFileSync(consentPaths(home).ledger, "utf8") : "")
const everyFileUnder = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? everyFileUnder(join(dir, e.name)) : [join(dir, e.name)]))
    : []

describe("bureau session import (non-interactive)", () => {
  it("fails without --domains and --yes, names what is missing, and reads nothing", async () => {
    expect(await cmdImport({ from: "chrome" }, deps())).toBe(1)
    expect(output()).toMatch(/--domains/)
    expect(output()).toMatch(/--yes/)
    expect(await cmdImport({ from: "chrome", domains: "github.com" }, deps())).toBe(1)
    expect(await cmdImport({ from: "chrome", yes: "true" }, deps())).toBe(1)
    expect(chrome.reads).toHaveLength(0)
  })

  it("requires --from chrome", async () => {
    expect(await cmdImport({ domains: "github.com", yes: "true" }, deps())).toBe(1)
    expect(output()).toContain("--from chrome")
    expect(await cmdImport({ from: "safari", domains: "github.com", yes: "true" }, deps())).toBe(1)
  })

  it.each(["*", "*.github.com", "all", ".com", "github.com,*.gitlab.com", "com"])("rejects the domain list %s", async domains => {
    expect(await cmdImport({ from: "chrome", domains, yes: "true" }, deps())).toBe(1)
    expect(chrome.reads).toHaveLength(0)
    expect(cmdGrants({}, deps())).toBe(0)
    expect(output()).toContain("no active consent grants")
  })

  it("imports the named domains with --yes and never prints a cookie value", async () => {
    expect(await cmdImport({ from: "chrome", domains: "github.com, gitlab.com", yes: "true", device: "dev-fp-1", session: "work" }, deps())).toBe(0)
    expect(chrome.reads).toEqual([{ profile: "Default", domains: ["github.com", "gitlab.com"] }])
    expect(output()).toMatch(/granted .*github\.com, gitlab\.com/)
    expect(output()).not.toContain(CANARY)
  })
})

describe("bureau session import (interactive)", () => {
  const ask = (answers: string[]) => async (q: string): Promise<string> => {
    asked.push(q)
    return answers.shift() ?? "n"
  }

  it("asks once per domain and grants only after every yes", async () => {
    expect(await cmdImport({ from: "chrome", domains: "github.com,gitlab.com" }, deps({ interactive: true, ask: ask(["y", "yes"]) }))).toBe(0)
    expect(asked).toHaveLength(2)
    expect(asked[0]).toContain("github.com")
    expect(asked[1]).toContain("gitlab.com")
    expect(output()).not.toContain(CANARY)
  })

  it("imports nothing when the human declines", async () => {
    expect(await cmdImport({ from: "chrome", domains: "github.com,gitlab.com" }, deps({ interactive: true, ask: ask(["y", "n"]) }))).toBe(1)
    expect(chrome.reads).toHaveLength(0)
    expect(cmdGrants({ all: "true" }, deps())).toBe(0)
    expect(output()).toContain("no consent grants")
  })
})

describe("bureau session list and revoke", () => {
  it("lists domains, granted-at and the device fingerprint, and no cookie values", async () => {
    await cmdImport({ from: "chrome", domains: "github.com", yes: "true", device: "dev-fp-1" }, deps())
    lines.length = 0
    expect(cmdGrants({}, deps())).toBe(0)
    expect(output()).toContain("github.com")
    expect(output()).toContain("granted 2026-09-29T12:00:00.000Z")
    expect(output()).toContain("device dev-fp-1")
    expect(output()).not.toContain(CANARY)
  })

  it("`session list` shows saved sessions and then the grants", async () => {
    await cmdImport({ from: "chrome", domains: "github.com", yes: "true" }, deps())
    lines.length = 0
    expect(await runSession(["list"], deps())).toBe(0)
    expect(output()).toContain("consent grants:")
    expect(output()).toContain("github.com")
  })

  it("revokes by domain: the grant reads back revoked, the jar is gone and the ledger has the row", async () => {
    await cmdImport({ from: "chrome", domains: "github.com,gitlab.com", yes: "true", session: "work" }, deps())
    const paths = consentPaths(home)
    const [grant] = fileGrantStore(paths.grants).list()
    expect(grant).toBeDefined()
    const materialBefore = [...everyFileUnder(paths.jars), ...everyFileUnder(paths.sessions)]
    expect(materialBefore.length).toBeGreaterThan(0)

    lines.length = 0
    expect(await cmdRevoke("GitHub.com", deps())).toBe(0)
    expect(output()).toContain(`revoked ${grant!.id}`)

    const after = fileGrantStore(paths.grants).list()
    expect(after.find(g => g.id === grant!.id)?.revokedAt).toBeDefined()
    expect(everyFileUnder(paths.jars)).toEqual([])
    expect(cmdGrants({}, deps())).toBe(0)
    expect(output()).toContain("no active consent grants")

    const rows = createConsentLedger({ path: paths.ledger }).read()
    expect(rows.map(r => r.event)).toEqual(["grant", "revoke"])
    expect(rows[1]?.grantId).toBe(grant!.id)
    expect(createConsentLedger({ path: paths.ledger }).verifyChain()).toBe(true)
  })

  it("revokes by grant id, and reports an unknown target", async () => {
    await cmdImport({ from: "chrome", domains: "github.com", yes: "true" }, deps())
    const [grant] = fileGrantStore(consentPaths(home).grants).list()
    expect(await cmdRevoke("no-such-grant.example", deps())).toBe(1)
    expect(output()).toContain("no active grant matches")
    expect(await cmdRevoke(grant!.id, deps())).toBe(0)
    lines.length = 0
    expect(await cmdRevoke(grant!.id, deps())).toBe(0)
    expect(output()).toContain("already revoked")
    expect(createConsentLedger({ path: consentPaths(home).ledger }).read().filter(r => r.event === "revoke")).toHaveLength(1)
    expect(await cmdRevoke(undefined, deps())).toBe(1)
  })

  it("keeps the canary cookie out of stdout, the ledger, the grants file and the log for the whole flow", async () => {
    await cmdImport({ from: "chrome", domains: "github.com", yes: "true", device: "dev-fp-1" }, deps())
    cmdGrants({ all: "true" }, deps())
    await cmdRevoke("github.com", deps())
    cmdGrants({ all: "true" }, deps())
    const paths = consentPaths(home)
    expect(output()).not.toContain(CANARY)
    expect(ledgerText()).not.toContain(CANARY)
    expect(ledgerText().length).toBeGreaterThan(0)
    expect(readFileSync(paths.grants, "utf8")).not.toContain(CANARY)
    expect(statSync(paths.ledger).mode & 0o077).toBe(0)
  })
})

describe("the agent cannot widen consent (F4)", () => {
  it("refuses to add a domain, change the profile or create a grant, and appends deny rows", async () => {
    await cmdImport({ from: "chrome", domains: "github.com", yes: "true", device: "dev-fp-1" }, deps())
    const paths = consentPaths(home)
    const [grant] = fileGrantStore(paths.grants).list()
    const agent = createAgentConsentSurface(makeHost(home, chrome), { deviceId: "dev-fp-1" })
    const readsBefore = chrome.reads.length

    await expect(agent.sync({ grantId: grant!.id, domains: ["github.com", "evil.example"] })).rejects.toThrow()
    await expect(agent.sync({ grantId: grant!.id, profile: "Profile 1" })).rejects.toThrow()
    await expect(agent.grant({ sessionId: "s", domains: ["evil.example"] })).rejects.toThrow()

    expect(chrome.reads.length).toBe(readsBefore)
    const after = fileGrantStore(paths.grants).list()
    expect(after).toHaveLength(1)
    expect(after[0]?.domains).toEqual(["github.com"])
    const events = createConsentLedger({ path: paths.ledger }).read().map(r => r.event)
    expect(events.filter(e => e === "deny").length).toBeGreaterThanOrEqual(3)
    expect(ledgerText()).not.toContain("evil.example\",\"value")
  })

  it("registers no MCP tool that can import, grant or revoke", async () => {
    const { buildCatalogue } = await import("../serve.js")
    const names = buildCatalogue({ plugins: [] }).entries.map(e => e.name)
    expect(names.filter(n => /import|grant|revoke|consent|profile/i.test(n))).toEqual([])
  })
})
