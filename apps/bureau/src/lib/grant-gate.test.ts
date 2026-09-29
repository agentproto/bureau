import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Server as HttpServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createConsentHost,
  createConsentLedger,
  fileSessionStore,
  localChromePort,
  memoryGrantStore,
  type Grant,
} from "@agentproto/browser-profiles"
import { createBureauHttpServer } from "./mcp-server.js"
import { createBureauPairing, type BureauPairing } from "./pairing.js"
import { gateEntriesByDevice } from "./grant-gate.js"
import type { McpEntry } from "../mcp-tool.js"
import { freePort, mcpCall } from "../__tests__/support/http.js"

let tmp: string
let server: HttpServer | undefined
let pairing: BureauPairing | undefined

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bureau-grants-"))
})
afterEach(async () => {
  await pairing?.registry.shutdown().catch(() => {})
  if (server) await new Promise<void>(r => server?.close(() => r()))
  server = undefined
  pairing = undefined
  await rm(tmp, { recursive: true, force: true })
})

const grant = (over: Partial<Grant>): Grant => ({
  id: "g1",
  sessionId: "work",
  source: { kind: "chrome", profile: "Default" },
  domains: ["github.com"],
  sinks: [{ kind: "local" }],
  grantedAt: "2026-01-01T00:00:00.000Z",
  grantedVia: "flag",
  cookieCount: 3,
  ...over,
})

const SESSION_TOOL: McpEntry = {
  name: "session_probe",
  description: "reads a session",
  jsonSchema: {
    type: "object",
    properties: { session: { type: "string" }, url: { type: "string" } },
  },
  call: async () => ({ content: [{ type: "text", text: "reached" }] }),
}
const PLAIN_TOOL: McpEntry = {
  name: "plain",
  description: "no session",
  jsonSchema: { type: "object", properties: {} },
  call: async () => ({ content: [{ type: "text", text: "plain-ok" }] }),
}

async function boot(grants: Grant[]): Promise<{ port: number; a: string; b: string; fpA: string }> {
  const port = await freePort()
  pairing = createBureauPairing({ home: tmp, port, ephemeralIdentity: true })
  const devA = await pairing.registry.mintLocalDevice({ name: "device-a" })
  const devB = await pairing.registry.mintLocalDevice({ name: "device-b" })
  const consent = createConsentHost({
    grants: memoryGrantStore(grants.map(g => (g.deviceId === "A" ? { ...g, deviceId: devA.fingerprint } : g))),
    ledger: createConsentLedger({ path: join(tmp, "ledger.jsonl") }),
    store: fileSessionStore(join(tmp, "sessions")),
    jarDir: join(tmp, "jars"),
    chrome: localChromePort({ chromeRoot: join(tmp, "chrome") }),
  })
  server = createBureauHttpServer({
    entries: gateEntriesByDevice([SESSION_TOOL, PLAIN_TOOL], consent),
    port,
    authorize: pairing.authorize,
  })
  await new Promise<void>(r => server?.listen(port, "127.0.0.1", r))
  return { port, a: devA.bearer, b: devB.bearer, fpA: devA.fingerprint }
}

const call = (port: number, bearer: string, name: string, args: Record<string, unknown>) =>
  mcpCall(port, "tools/call", { name, arguments: args }, bearer).then(r => {
    const result = (JSON.parse(r.body) as { result: { isError?: boolean; content: Array<{ text: string }> } }).result
    return { isError: result.isError === true, text: result.content[0]?.text ?? "" }
  })

describe("per-device grants", () => {
  it("serves device A (granted github.com) and refuses device B", async () => {
    const { port, a, b } = await boot([grant({ deviceId: "A" })])
    const args = { session: "work", url: "https://github.com/agentproto" }

    const okA = await call(port, a, "session_probe", args)
    expect(okA).toEqual({ isError: false, text: "reached" })

    const noB = await call(port, b, "session_probe", args)
    expect(noB.isError).toBe(true)
    expect(JSON.parse(noB.text)).toMatchObject({ error: "browser:consent_required" })
  })

  it("refuses device A on a domain its grant does not cover", async () => {
    const { port, a } = await boot([grant({ deviceId: "A" })])
    const res = await call(port, a, "session_probe", { session: "work", url: "https://example.com/" })
    expect(res.isError).toBe(true)
  })

  it("without a url, requires some active grant that serves the calling device", async () => {
    const { port, a, b } = await boot([grant({ deviceId: "A" })])
    expect((await call(port, a, "session_probe", { session: "work" })).isError).toBe(false)
    expect((await call(port, b, "session_probe", { session: "work" })).isError).toBe(true)
  })

  it("an unscoped grant serves any paired device", async () => {
    const { port, b } = await boot([grant({})])
    const res = await call(port, b, "session_probe", { session: "work", url: "https://github.com/x" })
    expect(res.isError).toBe(false)
  })

  it("a revoked grant serves nobody", async () => {
    const { port, a } = await boot([grant({ deviceId: "A", revokedAt: "2026-02-01T00:00:00.000Z" })])
    expect((await call(port, a, "session_probe", { session: "work", url: "https://github.com/x" })).isError).toBe(true)
  })

  it("leaves sessions with no consent grants, and tools without a session argument, untouched", async () => {
    const { port, b } = await boot([grant({ deviceId: "A" })])
    expect((await call(port, b, "session_probe", { session: "other" })).isError).toBe(false)
    expect(await call(port, b, "plain", {})).toEqual({ isError: false, text: "plain-ok" })
  })
})
