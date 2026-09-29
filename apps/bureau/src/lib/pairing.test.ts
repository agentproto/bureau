import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Server as HttpServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBureauHttpServer, type Authorize } from "./mcp-server.js"
import { createBureauPairing, type BureauPairing } from "./pairing.js"
import type { McpEntry } from "../mcp-tool.js"
import { FakeRendezvous, pairViaOffer } from "../__tests__/support/rendezvous.js"
import { freePort, mcpCall, rawRequest } from "../__tests__/support/http.js"

const ENTRIES: McpEntry[] = [
  {
    name: "noop",
    description: "does nothing",
    jsonSchema: { type: "object", properties: {} },
    call: async () => ({ content: [{ type: "text", text: "{}" }] }),
  },
]

interface Running {
  port: number
  pairing: BureauPairing
  logs: string[]
  authSeen: Array<string | undefined>
  server: HttpServer
}

let tmp: string
const running: Running[] = []
const closers: Array<() => Promise<void>> = []

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bureau-pairing-"))
})

afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => {})
  for (const r of running.splice(0)) {
    await r.pairing.registry.shutdown().catch(() => {})
    await new Promise<void>(res => r.server.close(() => res()))
  }
  vi.restoreAllMocks()
  await rm(tmp, { recursive: true, force: true })
})

async function start(rv?: FakeRendezvous): Promise<Running> {
  const port = await freePort()
  const logs: string[] = []
  const pairing = createBureauPairing({
    home: tmp,
    port,
    ephemeralIdentity: true,
    rendezvousUrl: "ws://broker.invalid/v1",
    ...(rv ? { dial: rv.dial } : {}),
    log: l => logs.push(l),
  })
  const authSeen: Array<string | undefined> = []
  const authorize: Authorize = req => {
    authSeen.push(req.headers.authorization)
    return pairing.authorize(req)
  }
  const server = createBureauHttpServer({ entries: ENTRIES, port, authorize })
  await new Promise<void>(res => server.listen(port, "127.0.0.1", res))
  const r: Running = { port, pairing, logs, authSeen, server }
  running.push(r)
  return r
}

describe("pairing is the only auth", () => {
  it("refuses an unauthenticated /mcp with 401 and a WWW-Authenticate hint, and leaks nothing", async () => {
    const { port } = await start()
    const res = await mcpCall(port, "tools/list")
    expect(res.status).toBe(401)
    expect(String(res.headers["www-authenticate"])).toMatch(/^Bearer/)
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" })
  })

  it("keeps /health open with {ok:true,tools:N}", async () => {
    const { port } = await start()
    const res = await rawRequest(port, "GET", "/health")
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, tools: 1 })
  })

  it("answers garbage, tampered and unknown bearers identically to a missing one", async () => {
    const { port, pairing } = await start()
    const dev = await pairing.registry.mintLocalDevice({ name: "cc" })
    const tampered = `${dev.bearer.slice(0, -4)}AAAA`
    const unknown = `apd1.${"0".repeat(32)}.${"A".repeat(43)}`
    for (const bad of ["nonsense", tampered, unknown]) {
      const res = await mcpCall(port, "tools/list", {}, bad)
      expect(res.status, bad).toBe(401)
      expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" })
    }
  })

  it("lets a locally paired bearer reach tools/list", async () => {
    const { port, pairing } = await start()
    const dev = await pairing.registry.mintLocalDevice({ name: "cc" })
    const res = await mcpCall(port, "tools/list", {}, dev.bearer)
    expect(res.status).toBe(200)
    const names = (JSON.parse(res.body) as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      t => t.name
    )
    expect(names).toEqual(["noop"])
  })

  it("invalidates a revoked device on the very next request", async () => {
    const { port, pairing } = await start()
    const dev = await pairing.registry.mintLocalDevice({ name: "cc" })
    expect((await mcpCall(port, "tools/list", {}, dev.bearer)).status).toBe(200)
    expect(await pairing.registry.revoke(dev.fingerprint)).toBe(true)
    expect((await mcpCall(port, "tools/list", {}, dev.bearer)).status).toBe(401)
  })

  it("honours a revoke made by another process (a second registry on the same file)", async () => {
    const { port, pairing } = await start()
    const dev = await pairing.registry.mintLocalDevice({ name: "cc" })
    expect((await mcpCall(port, "tools/list", {}, dev.bearer)).status).toBe(200)
    const { createOfflineRegistry } = await import("./pairing.js")
    expect(await createOfflineRegistry(tmp).revoke(dev.fingerprint)).toBe(true)
    expect((await mcpCall(port, "tools/list", {}, dev.bearer)).status).toBe(401)
  })

  it("still refuses a forged Host on the loopback socket", async () => {
    const { port, pairing } = await start()
    const dev = await pairing.registry.mintLocalDevice({ name: "cc" })
    const res = await rawRequest(
      port,
      "POST",
      "/mcp",
      {
        host: "evil.example",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${dev.bearer}`,
      },
      "{}"
    )
    expect(res.status).toBe(403)
  })
})

describe("remote paired channel", () => {
  it("reaches tools/list through serveLoopbackHttp; the peer's Authorization never reaches Bureau; other paths are 403", async () => {
    const rv = new FakeRendezvous()
    const { pairing, authSeen, logs } = await start(rv)
    const offer = await pairing.registry.createOffer({ ttlMs: 60_000 })
    const { client } = await pairViaOffer(rv, offer.url, "phone")
    closers.push(async () => client.close())
    await client.ready()

    const peerCanary = "peer-canary-7f3a9c"
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${peerCanary}`,
    }
    const listed = await client.forwardHttp({
      method: "POST",
      path: "/mcp",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    expect(listed.status).toBe(200)
    expect(listed.body.toString()).toContain('"noop"')

    const health = await client.forwardHttp({ method: "GET", path: "/health" })
    expect(health.status).toBe(200)

    for (const path of ["/watch/abc", "/cred-capture/x", "/mcp/../admin", "//evil"]) {
      const denied = await client.forwardHttp({ method: "GET", path, headers })
      expect(denied.status, path).not.toBe(200)
    }
    expect((await client.forwardHttp({ method: "GET", path: "/admin", headers })).status).toBe(403)

    expect(authSeen.length).toBeGreaterThan(0)
    for (const a of authSeen) expect(a ?? "").not.toContain(peerCanary)
    expect(logs.join("\n")).not.toContain(peerCanary)
  })

  it("does not accept a forged paired-device header without the gateway credential", async () => {
    const rv = new FakeRendezvous()
    const { port, pairing } = await start(rv)
    const offer = await pairing.registry.createOffer({ ttlMs: 60_000 })
    const { client } = await pairViaOffer(rv, offer.url, "phone")
    closers.push(async () => client.close())
    await client.ready()
    const fp = (await pairing.registry.list()).find(r => !r.local)?.fingerprint
    expect(fp).toBeTruthy()
    const res = await rawRequest(
      port,
      "POST",
      "/mcp",
      {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-bureau-paired-device": fp ?? "",
        authorization: "Bearer not-the-gateway",
      },
      "{}"
    )
    expect(res.status).toBe(401)
  })

  it("stops serving a revoked remote pairing", async () => {
    const rv = new FakeRendezvous()
    const { pairing } = await start(rv)
    const offer = await pairing.registry.createOffer({ ttlMs: 60_000 })
    const { client } = await pairViaOffer(rv, offer.url, "phone")
    closers.push(async () => client.close())
    await client.ready()
    const rec = (await pairing.registry.list()).find(r => !r.local)
    expect(rec).toBeTruthy()
    expect(await pairing.registry.revoke(rec?.fingerprint ?? "")).toBe(true)
    const authorized = await pairing.authorize(
      // A request as the gateway would forward it, after the pairing is gone.
      fakeReq({ authorization: "Bearer whatever", "x-bureau-paired-device": rec?.fingerprint ?? "" })
    )
    expect(authorized).toBe(false)
  })
})

describe("secrets stay out of logs and errors", () => {
  it("never surfaces the device bearer or its MAC in logs, console, or responses", async () => {
    const consoleLines: string[] = []
    for (const m of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleLines.push(a.map(String).join(" ")))

    const { port, pairing, logs } = await start()
    const dev = await pairing.registry.mintLocalDevice({ name: "canary" })
    const mac = dev.bearer.split(".")[2] ?? ""
    expect(mac.length).toBeGreaterThan(20)

    const bodies: string[] = []
    const record = (r: { body: string; headers: Record<string, string | string[] | undefined> }): void => {
      bodies.push(r.body, JSON.stringify(r.headers))
    }
    record(await mcpCall(port, "tools/list", {}, dev.bearer))
    record(await mcpCall(port, "tools/list", {}, `${dev.bearer}x`))
    record(await mcpCall(port, "tools/list", {}, `apd1.${dev.fingerprint}.${"B".repeat(43)}`))
    await pairing.registry.revoke(dev.fingerprint)
    record(await mcpCall(port, "tools/list", {}, dev.bearer))

    const everything = [...logs, ...consoleLines, ...bodies].join("\n")
    expect(everything).not.toContain(dev.bearer)
    expect(everything).not.toContain(mac)
  })
})

function fakeReq(headers: Record<string, string>): Parameters<Authorize>[0] {
  return { headers, socket: { remoteAddress: "127.0.0.1" } } as unknown as Parameters<Authorize>[0]
}
