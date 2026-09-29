import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createFakeBrowserProvider } from "@agentproto/driver-browser"
import type { DoctorPort } from "@agentproto/browser-profiles"
import { collectDoctor, formatDoctor, runDoctorCommand, type BureauDoctorDeps, type DoctorOutput } from "./doctor.js"
import { pairingsPathIn } from "../lib/pairing.js"
import { allowLoopback } from "../lib/mcp-server.js"
import type { BureauPlugin } from "../plugin.js"
import { CANARY, consentPaths, fakeChromePort, makeHost } from "../__tests__/support/consent-fixture.js"

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bureau-doctor-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const LOCAL_STATE = JSON.stringify({ profile: { info_cache: { Default: { name: "Person 1" } } } })
const BINARY = "/usr/local/bin/node-for-bureau"

const okChrome: DoctorPort = { binary: BINARY, readLocalState: () => LOCAL_STATE, copyCookiesDb: () => {} }
const errno = (code: string): Error => Object.assign(new Error(code), { code })

const deps = (over: BureauDoctorDeps = {}): BureauDoctorDeps => ({
  home,
  env: {},
  platform: "linux",
  camofoxHealth: async () => ({ status: 200, body: { ok: true, engine: "camoufox", browserState: "running" } }),
  providerCheck: async () => ({ ok: true, detail: "usable" }),
  chromePort: okChrome,
  ...over,
})

const row = (report: DoctorOutput, id: string) => report.checks.find(c => c.id === id)

describe("bureau doctor matrix", () => {
  it("passes when everything is healthy", async () => {
    const report = await collectDoctor([], deps())
    expect(report.ok).toBe(true)
    expect(report.browser).toBe("camofox")
    expect(row(report, "provider:camofox")?.status).toBe("ok")
    expect(row(report, "camofox")?.status).toBe("ok")
    expect(row(report, "chrome-local-state")?.status).toBe("ok")
    expect(row(report, "pairing-store")?.status).toBe("skipped")
    expect(row(report, "authorize")?.detail).toContain("pairing")
  })

  it("fails an unknown browser and lists what is registered", async () => {
    const report = await collectDoctor(["--browser", "netscape"], deps())
    expect(report.ok).toBe(false)
    const provider = row(report, "provider")
    expect(provider?.status).toBe("fail")
    expect(provider?.detail).toContain("camofox")
    expect(provider?.fix).toBeTruthy()
  })

  it("fails an unusable provider with its fix hint", async () => {
    const report = await collectDoctor(["--browser", "chrome"], deps({ providerCheck: async () => ({ ok: false, detail: "no Chrome binary found", fix: "Install Google Chrome." }) }))
    expect(report.ok).toBe(false)
    expect(row(report, "provider:chrome")).toMatchObject({ status: "fail", fix: "Install Google Chrome." })
  })

  it("checks a third-party provider through its own check()", async () => {
    const { provider } = createFakeBrowserProvider({ id: "acme" })
    const plugin: BureauPlugin = { name: "acme", entries: () => [], browsers: [provider] }
    const report = await collectDoctor(["--browser", "acme"], { ...deps(), providerCheck: undefined, plugins: [plugin] })
    expect(row(report, "provider:acme")).toBeDefined()
  })

  it("maps camofox states: fails when camofox is the browser and crash-looping, skips when it is not", async () => {
    const crashing = async () => ({ status: 503, body: { ok: false, engine: "camoufox", browserState: "crash-looping" } })
    const active = await collectDoctor([], deps({ camofoxHealth: crashing }))
    expect(row(active, "camofox")?.status).toBe("fail")
    expect(row(active, "camofox")?.detail).toContain("503")
    expect(row(active, "camofox")?.fix).toContain("bureau start")
    expect(active.ok).toBe(false)

    const unreachable = await collectDoctor([], deps({ camofoxHealth: async () => Promise.reject(new Error("ECONNREFUSED")) }))
    expect(row(unreachable, "camofox")?.status).toBe("fail")

    const other = await collectDoctor(["--browser", "chrome"], deps({ camofoxHealth: crashing }))
    expect(row(other, "camofox")?.status).toBe("skipped")
    expect(other.ok).toBe(true)
  })

  it("classifies EPERM on the cookies db as Full Disk Access and names the binary", async () => {
    const port: DoctorPort = { ...okChrome, copyCookiesDb: () => { throw errno("EPERM") } }
    const report = await collectDoctor([], deps({ chromePort: port }))
    const fda = row(report, "full-disk-access")
    expect(fda?.status).toBe("fail")
    expect(fda?.detail).toContain(BINARY)
    expect(fda?.fix).toContain(BINARY)
    expect(row(report, "chrome-cookies")).toBeUndefined()
    expect(report.ok).toBe(false)
  })

  it("reports a missing cookies db and a missing Local State as their own failures", async () => {
    const report = await collectDoctor(
      [],
      deps({ chromePort: { ...okChrome, readLocalState: () => { throw errno("ENOENT") }, copyCookiesDb: () => { throw errno("ENOENT") } } })
    )
    expect(row(report, "chrome-local-state")?.status).toBe("fail")
    expect(row(report, "chrome-cookies")?.status).toBe("fail")
    expect(row(report, "full-disk-access")).toBeUndefined()
  })

  it("skips the Keychain unless asked", async () => {
    let probed = 0
    const port: DoctorPort = { ...okChrome, probeKeychain: () => { probed += 1 } }
    await collectDoctor([], deps({ chromePort: port }))
    expect(probed).toBe(0)
    const report = await collectDoctor(["--keychain"], deps({ chromePort: port }))
    expect(probed).toBe(1)
    expect(row(report, "keychain")?.status).toBe("ok")
  })

  it("fails a pairing store or ledger that other users can read, with a chmod hint", async () => {
    const report = await collectDoctor(
      [],
      deps({ fileMode: path => (path.endsWith("consent-ledger.jsonl") ? 0o644 : path === pairingsPathIn(home) ? 0o600 : null), verifyLedger: () => true })
    )
    expect(row(report, "pairing-store")?.status).toBe("ok")
    const ledger = row(report, "consent-ledger")
    expect(ledger?.status).toBe("fail")
    expect(ledger?.detail).toContain("644")
    expect(ledger?.fix).toContain("chmod 600")
    expect(report.ok).toBe(false)
  })

  it("fails a second plugin that supplies authorize, and reports a single one", async () => {
    const one: BureauPlugin = { name: "studio", entries: () => [], authorize: allowLoopback }
    const two: BureauPlugin = { name: "other", entries: () => [], authorize: allowLoopback }
    expect(row(await collectDoctor([], deps({ plugins: [one] })), "authorize")?.detail).toContain("studio")
    const clash = await collectDoctor([], deps({ plugins: [one, two] }))
    expect(row(clash, "authorize")?.status).toBe("fail")
  })
})

describe("bureau doctor against real store files", () => {
  const seedLedger = async (): Promise<string> => {
    const host = makeHost(home, fakeChromePort())
    await host.importFromChrome({ sessionId: "s", profile: "Default", domains: ["github.com"], yes: true, deviceId: "dev" })
    await host.importFromChrome({ sessionId: "s", profile: "Default", domains: ["gitlab.com"], yes: true, deviceId: "dev" })
    return consentPaths(home).ledger
  }

  it("verifies an intact 0600 ledger", async () => {
    const ledger = await seedLedger()
    const report = await collectDoctor([], deps({ platform: process.platform }))
    expect(row(report, "consent-ledger")?.status).toBe("ok")
    expect(row(report, "consent-ledger-chain")?.status).toBe("ok")
    expect(readFileSync(ledger, "utf8")).not.toContain(CANARY)
  })

  it("fails a broken chain when a ledger row is edited", async () => {
    const ledger = await seedLedger()
    chmodSync(ledger, 0o600)
    const lines = readFileSync(ledger, "utf8").trimEnd().split("\n")
    lines[0] = lines[0]!.replace("github.com", "evil.example")
    writeFileSync(ledger, `${lines.join("\n")}\n`, { mode: 0o600 })
    const report = await collectDoctor([], deps({ platform: process.platform }))
    const chain = row(report, "consent-ledger-chain")
    expect(chain?.status).toBe("fail")
    expect(chain?.detail).toContain("broken")
    expect(report.ok).toBe(false)
  })

  it("fails a ledger that is not valid JSON", async () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(consentPaths(home).ledger, "not json\n", { mode: 0o600 })
    const report = await collectDoctor([], deps({ platform: process.platform }))
    expect(row(report, "consent-ledger-chain")?.status).toBe("fail")
  })
})

describe("bureau doctor command", () => {
  it("prints a checklist with fix hints and exits 1 on a failure", async () => {
    const lines: string[] = []
    const code = await runDoctorCommand(["--browser", "netscape"], [], { ...deps(), plugins: [], log: l => lines.push(l) })
    expect(code).toBe(1)
    const text = lines.join("\n")
    expect(text).toContain("[FAIL] provider")
    expect(text).toContain("fix:")
    expect(text).toContain("check(s) failed")
  })

  it("prints JSON with --json and exits 0 when healthy", async () => {
    const lines: string[] = []
    const code = await runDoctorCommand(["--json"], [], { ...deps(), plugins: [], log: l => lines.push(l) })
    expect(code).toBe(0)
    const parsed = JSON.parse(lines.join("\n")) as DoctorOutput
    expect(parsed.ok).toBe(true)
    expect(parsed.checks.every(c => typeof c.id === "string" && typeof c.detail === "string")).toBe(true)
  })

  it("formats a passing report", async () => {
    const text = formatDoctor(await collectDoctor([], deps()))
    expect(text).toContain("all checks passed")
    expect(text).not.toMatch(/—/)
  })
})
