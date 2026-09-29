import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ConsentHost } from "@agentproto/browser-profiles"
import type { DeviceIdentity } from "./device-context.js"
import { runAsDevice } from "./device-context.js"
import { createApproval, loadApproverPublic, loadOrCreateApproverKey } from "./lease-approval.js"
import { createLeaseLedger, leaseLedgerPathIn, type LeaseLedger } from "./lease-ledger.js"
import { createLeaseService, LeaseError, type LeaseService } from "./session-lease.js"
import { CANARY, fakeChromePort, makeHost } from "../__tests__/support/consent-fixture.js"

const DEV_A = "fp-device-a"
const DEV_B = "fp-device-b"
const devA: DeviceIdentity = { fingerprint: DEV_A } as DeviceIdentity
const devB: DeviceIdentity = { fingerprint: DEV_B } as DeviceIdentity
const T0 = Date.parse("2026-09-29T10:00:00.000Z")

let home: string
let clock: number
let host: ConsentHost
let ledger: LeaseLedger
let svc: LeaseService
let logs: string[]
let n: number

const now = (): Date => new Date(clock)

async function grantFor(deviceId: string, domains: string[]): Promise<void> {
  await host.importFromChrome({ sessionId: "sess1", profile: "Default", domains, yes: true, deviceId })
}

function approve(over: { domains?: string[]; device?: string; session?: string; ttl?: number; validFor?: number } = {}): string {
  const key = loadOrCreateApproverKey(home)
  return createApproval({
    home,
    key,
    sessionId: over.session ?? "sess1",
    domains: over.domains ?? ["example.com"],
    deviceFingerprint: over.device ?? DEV_A,
    maxTtlSeconds: over.ttl ?? 300,
    validForSeconds: over.validFor ?? 600,
    now,
  }).id
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof LeaseError) return e.code
    throw e
  }
  return "no-error"
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bureau-lease-"))
  clock = T0
  n = 0
  logs = []
  host = makeHost(home, fakeChromePort(), undefined, now)
  ledger = createLeaseLedger({ path: leaseLedgerPathIn(home), now })
  svc = createLeaseService({
    home,
    consent: host,
    ledger,
    approver: () => loadApproverPublic(home),
    now,
    newId: () => `ls_test${++n}`,
    timers: false,
    log: l => logs.push(l),
  })
})

afterEach(async () => {
  svc.close()
  await rm(home, { recursive: true, force: true })
})

describe("session lease", () => {
  it("issues only the granted domain's cookies, once per approval", async () => {
    await grantFor(DEV_A, ["example.com"])
    const id = approve()
    const lease = svc.issue({ sessionId: "sess1", domains: ["example.com"], ttlSeconds: 120, approvalId: id }, devA)
    expect(lease.receiver).toBe("memory-only")
    expect(lease.ttlSeconds).toBe(120)
    expect(lease.expiresAt).toBe(new Date(T0 + 120_000).toISOString())
    expect(lease.cookies.length).toBeGreaterThan(0)
    expect(lease.cookies.every(c => c.domain.endsWith("example.com"))).toBe(true)
    expect(lease.cookies[0]?.value).toBe(CANARY)
    expect(ledger.read().map(r => r.event)).toEqual(["issue"])
  })

  it("refuses a domain that was never approved", async () => {
    await grantFor(DEV_A, ["example.com", "other.org"])
    const id = approve({ domains: ["example.com"] })
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com", "other.org"], approvalId: id }, devA))).toBe("payload_mismatch")
  })

  it("refuses a domain outside the device's grant, even with an approval", async () => {
    await grantFor(DEV_A, ["example.com"])
    const id = approve({ domains: ["other.org"] })
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["other.org"], approvalId: id }, devA))).toBe("domain_not_granted")
  })

  it("refuses a device that has no grant, though another device does", async () => {
    await grantFor(DEV_A, ["example.com"])
    const id = approve({ device: DEV_B })
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: id }, devB))).toBe("domain_not_granted")
  })

  it("refuses an approval issued to a different device", async () => {
    await grantFor(DEV_A, ["example.com"])
    await grantFor(DEV_B, ["example.com"])
    const id = approve({ device: DEV_A })
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: id }, devB))).toBe("not_requester")
  })

  it("refuses an agent path with no human approval (F4)", async () => {
    await grantFor(DEV_A, ["example.com"])
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"] }, devA))).toBe("approval_required")
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: "" }, devA))).toBe("approval_required")
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: "apr_forged" }, devA))).toBe("approval_not_found")
  })

  it("refuses an anonymous caller", () => {
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: "x" }, undefined))).toBe("no_device")
  })

  it("refuses a replayed approval", async () => {
    await grantFor(DEV_A, ["example.com"])
    const id = approve()
    svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: id }, devA)
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: id }, devA))).toBe("approval_already_consumed")
  })

  it("refuses a replay even after the approval file is reset to approved", async () => {
    await grantFor(DEV_A, ["example.com"])
    const id = approve()
    const requestPath = join(home, "approvals", id, "request.json")
    const original = readFileSync(requestPath, "utf8")
    svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: id }, devA)
    writeFileSync(requestPath, original)
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: id }, devA))).toBe("approval_already_consumed")
  })

  it("refuses an expired approval", async () => {
    await grantFor(DEV_A, ["example.com"])
    const id = approve({ validFor: 30 })
    clock += 31_000
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: id }, devA))).toBe("approval_expired")
  })

  it("refuses a tampered approval signature", async () => {
    await grantFor(DEV_A, ["example.com"])
    const id = approve()
    const sigPath = join(home, "approvals", id, "signature.json")
    const sig = JSON.parse(readFileSync(sigPath, "utf8")) as { signature: { value: string } }
    const flipped = sig.signature.value.startsWith("A") ? "B" : "A"
    sig.signature.value = flipped + sig.signature.value.slice(1)
    writeFileSync(sigPath, JSON.stringify(sig))
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: id }, devA))).toBe("signature_invalid")
  })

  it("refuses an approval whose payload was edited to widen it", async () => {
    await grantFor(DEV_A, ["example.com", "other.org"])
    const id = approve({ domains: ["example.com"] })
    const payloadPath = join(home, "approvals", id, "payload.json")
    const widened = readFileSync(payloadPath, "utf8").replace('"example.com"', '"example.com","other.org"')
    writeFileSync(payloadPath, widened)
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com", "other.org"], approvalId: id }, devA))).toBe("payload_mismatch")
  })

  it("refuses an approval signed by a different key", async () => {
    await grantFor(DEV_A, ["example.com"])
    const id = approve()
    const other = await mkdtemp(join(tmpdir(), "bureau-lease-other-"))
    try {
      const rogue = createApproval({
        home,
        key: loadOrCreateApproverKey(other),
        sessionId: "sess1",
        domains: ["example.com"],
        deviceFingerprint: DEV_A,
        maxTtlSeconds: 300,
        validForSeconds: 600,
        now,
        newId: () => "apr_rogue",
      })
      expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: rogue.id }, devA))).toBe("signature_invalid")
      void id
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it("expires a lease and refuses its next use", async () => {
    await grantFor(DEV_A, ["example.com"])
    const lease = svc.issue({ sessionId: "sess1", domains: ["example.com"], ttlSeconds: 60, approvalId: approve() }, devA)
    expect(svc.use(lease.leaseId, devA).cookies.length).toBeGreaterThan(0)
    clock += 61_000
    expect(codeOf(() => svc.use(lease.leaseId, devA))).toBe("lease_expired")
    expect(ledger.read().map(r => r.event)).toEqual(["issue", "use", "expire", "deny"])
  })

  it("caps the ttl at the service maximum", async () => {
    await grantFor(DEV_A, ["example.com"])
    const lease = svc.issue({ sessionId: "sess1", domains: ["example.com"], ttlSeconds: 99_999, approvalId: approve({ ttl: 900 }) }, devA)
    expect(lease.ttlSeconds).toBe(900)
  })

  it("revoke takes effect on the next use", async () => {
    await grantFor(DEV_A, ["example.com"])
    const lease = svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: approve() }, devA)
    expect(svc.revoke(lease.leaseId, devA)).toEqual({ leaseId: lease.leaseId, revoked: true })
    expect(codeOf(() => svc.use(lease.leaseId, devA))).toBe("lease_revoked")
  })

  it("another device cannot use or revoke a lease", async () => {
    await grantFor(DEV_A, ["example.com"])
    const lease = svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: approve() }, devA)
    expect(codeOf(() => svc.use(lease.leaseId, devB))).toBe("lease_not_found")
    expect(codeOf(() => svc.revoke(lease.leaseId, devB))).toBe("lease_not_found")
  })

  it("revoking the consent grant ends the lease on its next use", async () => {
    await grantFor(DEV_A, ["example.com"])
    const lease = svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: approve() }, devA)
    const grant = host.listGrants().find(g => g.sessionId === "sess1")
    await host.revoke(grant?.id ?? "")
    expect(codeOf(() => svc.use(lease.leaseId, devA))).toBe("domain_not_granted")
  })

  it("puts every lease event in a hash chain that verifies, with no cookie value in it", async () => {
    await grantFor(DEV_A, ["example.com"])
    const id = approve()
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"] }, devA))).toBe("approval_required")
    const lease = svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: id }, devA)
    svc.use(lease.leaseId, devA)
    expect(codeOf(() => svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: id }, devA))).toBe("approval_already_consumed")
    svc.revoke(lease.leaseId, devA)
    const lease2 = svc.issue({ sessionId: "sess1", domains: ["example.com"], ttlSeconds: 10, approvalId: approve() }, devA)
    clock += 11_000
    svc.sweep()
    expect(lease2.leaseId).not.toBe(lease.leaseId)

    const rows = ledger.read()
    expect(rows.map(r => r.event)).toEqual(["deny", "issue", "use", "deny", "revoke", "issue", "expire"])
    expect(ledger.verifyChain()).toBe(true)
    const raw = readFileSync(ledger.path, "utf8")
    expect(raw).not.toContain(CANARY)
    expect(logs.join("\n")).not.toContain(CANARY)
    if (process.platform !== "win32") expect(statSync(ledger.path).mode & 0o777).toBe(0o600)

    const lines = raw.split("\n").filter(Boolean)
    lines[1] = lines[1]?.replace('"issue"', '"use"') ?? ""
    writeFileSync(ledger.path, `${lines.join("\n")}\n`)
    expect(ledger.verifyChain()).toBe(false)
  })

  it("keeps the canary out of deny responses and logs", async () => {
    await grantFor(DEV_A, ["example.com"])
    const entries = svc.entries()
    const call = entries.find(e => e.name === "session_lease")
    const denied = await runAsDevice(devA, () => call?.call({ session: "sess1", domains: ["example.com"] }) ?? Promise.reject(new Error("no entry")))
    expect(denied.isError).toBe(true)
    const text = JSON.stringify(denied)
    expect(text).toContain("approval_required")
    expect(text).not.toContain(CANARY)
    expect(logs.join("\n")).not.toContain(CANARY)
  })

  it("exposes session_lease and session_lease_revoke as tools that route through the device context", async () => {
    await grantFor(DEV_A, ["example.com"])
    const entries = svc.entries()
    expect(entries.map(e => e.name)).toEqual(["session_lease", "session_lease_revoke"])
    const lease = entries.find(e => e.name === "session_lease")
    const revoke = entries.find(e => e.name === "session_lease_revoke")
    const issued = await runAsDevice(devA, () =>
      lease?.call({ session: "sess1", domains: ["example.com"], approvalId: approve() }) ?? Promise.reject(new Error("no entry"))
    )
    expect(issued.isError).toBeUndefined()
    const body = JSON.parse((issued.content[0] as { text: string }).text) as { leaseId: string }
    await runAsDevice(devA, () => revoke?.call({ leaseId: body.leaseId }) ?? Promise.reject(new Error("no entry")))
    const again = await runAsDevice(devA, () => lease?.call({ leaseId: body.leaseId }) ?? Promise.reject(new Error("no entry")))
    expect(again.isError).toBe(true)
    expect(JSON.stringify(again)).toContain("lease_revoked")
    expect(JSON.stringify(again)).not.toContain(CANARY)
  })
})

describe("lease-approve command", () => {
  it("refuses --yes and a non-interactive terminal, and signs only after a typed yes", async () => {
    const { cmdLeaseApprove } = await import("../commands/session-lease.js")
    await grantFor(DEV_A, ["example.com"])
    const say: string[] = []
    const base = { home, log: (l: string) => say.push(l), now, interactive: true }
    const flags = { session: "sess1", device: DEV_A, domains: "example.com" }
    expect(await cmdLeaseApprove({ ...flags, yes: "true" }, { ...base, ask: async () => "yes" })).toBe(1)
    expect(await cmdLeaseApprove(flags, { ...base, interactive: false, ask: async () => "yes" })).toBe(1)
    expect(await cmdLeaseApprove(flags, { ...base, ask: async () => "no" })).toBe(1)
    expect(await cmdLeaseApprove({ ...flags, domains: "nope.org" }, { ...base, ask: async () => "yes" })).toBe(1)
    expect(await cmdLeaseApprove(flags, { ...base, ask: async () => "yes" })).toBe(0)
    const id = /approved (\S+):/.exec(say.join("\n"))?.[1]
    expect(id).toBeTruthy()
    const lease = svc.issue({ sessionId: "sess1", domains: ["example.com"], approvalId: id }, devA)
    expect(lease.cookies.length).toBeGreaterThan(0)
    expect(say.join("\n")).not.toContain(CANARY)
  })
})
