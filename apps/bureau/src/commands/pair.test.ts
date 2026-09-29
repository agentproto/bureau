import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBureauPairing, type BureauPairing } from "../lib/pairing.js"
import { controlRequest, controlSocketPath, startControlServer, type ControlServer } from "../lib/pairing-control.js"
import { runDevices, runPair } from "./pair.js"
import { FakeRendezvous } from "../__tests__/support/rendezvous.js"

let home: string
let pairing: BureauPairing | undefined
let control: ControlServer | undefined
let lines: string[]

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "bur-"))
  lines = []
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await control?.close()
  await pairing?.registry.shutdown().catch(() => {})
  control = undefined
  pairing = undefined
  await rm(home, { recursive: true, force: true })
})

async function serverUp(opts: { hosted: boolean }): Promise<BureauPairing> {
  const rv = new FakeRendezvous()
  pairing = createBureauPairing({
    home,
    port: 1,
    ephemeralIdentity: true,
    dial: rv.dial,
    ...(opts.hosted ? {} : { rendezvousUrl: "ws://own.invalid/v1" }),
  })
  control = await startControlServer(home, pairing.registry)
  return pairing
}

describe("control socket", () => {
  it("is 0600 and answers null when nothing listens", async () => {
    expect(await controlRequest(home, { op: "list" })).toBeNull()
    await serverUp({ hosted: false })
    expect((await stat(controlSocketPath(home))).mode & 0o777).toBe(0o600)
    expect(await controlRequest(home, { op: "list" })).toEqual({ ok: true, devices: [] })
  })

  it("refuses a second server on a live home", async () => {
    const p = await serverUp({ hosted: false })
    await expect(startControlServer(home, p.registry)).rejects.toThrow(/already serving/)
  })
})

describe("bureau pair", () => {
  it("prints the offer URL, the identity and the hosted-rendezvous warning", async () => {
    await serverUp({ hosted: true })
    expect(await runPair(["--no-qr"], home)).toBe(0)
    const text = lines.join("\n")
    expect(text).toMatch(/agentproto:\/\/pair\?/)
    expect(text).toMatch(/hosted rendezvous/i)
    expect(text).toMatch(/connection metadata/)
    expect(text).not.toContain("—")
  })

  it("omits the warning for an own rendezvous", async () => {
    await serverUp({ hosted: false })
    expect(await runPair(["--no-qr"], home)).toBe(0)
    const text = lines.join("\n")
    expect(text).toContain("Relaying through ws://own.invalid/v1")
    expect(text).not.toMatch(/hosted rendezvous/i)
  })

  it("explains itself when no Bureau is running", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    expect(await runPair([], home)).toBe(1)
    expect(String(err.mock.calls[0]?.[0])).toMatch(/no Bureau is running/)
  })
})

describe("bureau devices", () => {
  it("lists and revokes over the same pairings.json, with or without a running server", async () => {
    const p = await serverUp({ hosted: false })
    const dev = await p.registry.mintLocalDevice({ name: "cc" })

    expect(await runDevices(["list"], home)).toBe(0)
    expect(lines.join("\n")).toContain(dev.fingerprint)
    expect(lines.join("\n")).toContain("cc")
    expect(lines.join("\n")).not.toContain(dev.bearer)

    expect(await runDevices(["revoke", "cc"], home)).toBe(0)
    expect(await p.registry.verifyDeviceBearer(dev.bearer)).toBeNull()

    await control?.close()
    control = undefined
    const second = await p.registry.mintLocalDevice({ name: "cursor" })
    expect(await runDevices(["revoke", second.fingerprint], home)).toBe(0)
    expect(await p.registry.verifyDeviceBearer(second.bearer)).toBeNull()

    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    expect(await runDevices(["revoke", "nobody"], home)).toBe(1)
  })
})
