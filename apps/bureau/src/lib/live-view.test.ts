import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { get, request, type IncomingMessage, type Server as HttpServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConsentHost, createConsentLedger, fileSessionStore, localChromePort, memoryGrantStore, type Grant } from "@agentproto/browser-profiles"
import { runAsDevice, type DeviceIdentity } from "./device-context.js"
import { assertDeviceMaySeeSession } from "./grant-gate.js"
import { createLiveView, LIVE_BOUNDARY, type LiveFrame } from "./live-view.js"
import { createBureauHttpServer } from "./mcp-server.js"
import { createBureauPairing, REMOTE_ALLOW_PATHS, type BureauPairing } from "./pairing.js"
import { freePort, rawRequest } from "../__tests__/support/http.js"

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0x03, 0xff, 0xd9])

let tmp: string
let server: HttpServer | undefined
let pairing: BureauPairing | undefined

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "bureau-live-"))
})
afterEach(async () => {
  await pairing?.registry.shutdown().catch(() => {})
  if (server) {
    server.closeAllConnections()
    await new Promise<void>(r => server?.close(() => r()))
  }
  server = undefined
  pairing = undefined
  await rm(tmp, { recursive: true, force: true })
})

const grant = (deviceId: string): Grant => ({
  id: "g1",
  sessionId: "work",
  deviceId,
  source: { kind: "chrome", profile: "Default" },
  domains: ["github.com"],
  sinks: [{ kind: "local" }],
  grantedAt: "2026-01-01T00:00:00.000Z",
  grantedVia: "flag",
  cookieCount: 1,
})

interface Booted {
  port: number
  a: string
  b: string
  grabs: { n: number }
}

async function boot(opts: { open?: string[]; maxStreamsPerDevice?: number } = {}): Promise<Booted> {
  const port = await freePort()
  pairing = createBureauPairing({ home: tmp, port, ephemeralIdentity: true })
  const devA = await pairing.registry.mintLocalDevice({ name: "device-a" })
  const devB = await pairing.registry.mintLocalDevice({ name: "device-b" })
  const consent = createConsentHost({
    grants: memoryGrantStore([grant(devA.fingerprint)]),
    ledger: createConsentLedger({ path: join(tmp, "ledger.jsonl") }),
    store: fileSessionStore(join(tmp, "sessions")),
    jarDir: join(tmp, "jars"),
    chrome: localChromePort({ chromeRoot: join(tmp, "chrome") }),
  })
  const open = new Set(opts.open ?? ["work"])
  const grabs = { n: 0 }
  const live = createLiveView({
    intervalMs: 5,
    minIntervalMs: 1,
    ...(opts.maxStreamsPerDevice ? { maxStreamsPerDevice: opts.maxStreamsPerDevice } : {}),
    frames: async session =>
      open.has(session)
        ? async (): Promise<LiveFrame> => {
            grabs.n += 1
            return { bytes: JPEG, mime: "image/jpeg" }
          }
        : undefined,
    mayView: (device: DeviceIdentity | undefined, session) => {
      if (!device) return false
      try {
        runAsDevice(device, () => assertDeviceMaySeeSession(consent, { session }))
        return true
      } catch {
        return false
      }
    },
  })
  server = createBureauHttpServer({ entries: [], port, authorize: pairing.authorize, liveView: live })
  await new Promise<void>(r => server?.listen(port, "127.0.0.1", r))
  return { port, a: devA.bearer, b: devB.bearer, grabs }
}

const auth = (bearer: string): Record<string, string> => ({ authorization: `Bearer ${bearer}` })

function streamFrames(port: number, path: string, bearer: string, want: number): Promise<{ res: IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path, headers: auth(bearer) }, res => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => {
        chunks.push(c)
        const text = Buffer.concat(chunks).toString("latin1")
        if (text.split(`--${LIVE_BOUNDARY}`).length - 1 >= want) {
          req.destroy()
          resolve({ res, body: Buffer.concat(chunks) })
        }
      })
      res.on("end", () => resolve({ res, body: Buffer.concat(chunks) }))
    })
    req.on("error", e => {
      if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e)
    })
  })
}

describe("GET /live/<session>", () => {
  it("streams MJPEG frames to a paired device that has a grant", async () => {
    const { port, a } = await boot()
    const { res, body } = await streamFrames(port, "/live/work", a, 2)
    expect(res.statusCode).toBe(200)
    expect(res.headers["content-type"]).toBe(`multipart/x-mixed-replace; boundary=${LIVE_BOUNDARY}`)
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(body.includes(Buffer.from(JPEG))).toBe(true)
    expect(body.toString("latin1")).toContain("content-type: image/jpeg")
  })

  it("answers 401 without a bearer or with a bad one, with no detail", async () => {
    const { port } = await boot()
    for (const headers of [{}, auth("apd1.nope.nope"), { authorization: "Basic abc" }]) {
      const r = await rawRequest(port, "GET", "/live/work", headers)
      expect(r.status).toBe(401)
      expect(JSON.parse(r.body)).toEqual({ error: "unauthorized" })
      expect(r.headers["www-authenticate"]).toContain("Bearer")
    }
  })

  it("answers 403 to a paired device with no grant, and streams nothing", async () => {
    const { port, b, grabs } = await boot()
    const r = await rawRequest(port, "GET", "/live/work", auth(b))
    expect(r.status).toBe(403)
    expect(r.body).toBe(JSON.stringify({ error: "forbidden" }))
    expect(grabs.n).toBe(0)
  })

  it("answers 405 to every method but GET, even without auth", async () => {
    const { port, a } = await boot()
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const headers of [{}, auth(a)]) {
        const r = await rawRequest(port, method, "/live/work", { ...headers, "content-length": "3" }, "x=1")
        expect(r.status, method).toBe(405)
        expect(r.headers["allow"]).toBe("GET")
      }
    }
  })

  it("answers 404 for a session that is not open, and never opens one", async () => {
    const { port, a } = await boot({ open: [] })
    expect((await rawRequest(port, "GET", "/live/work", auth(a))).status).toBe(404)
    expect((await rawRequest(port, "GET", "/live/", auth(a))).status).toBe(404)
    expect((await rawRequest(port, "GET", "/live/a/b", auth(a))).status).toBe(404)
  })

  it("rejects a foreign Host header", async () => {
    const { port, a } = await boot()
    const r = await rawRequest(port, "GET", "/live/work", { ...auth(a), host: "evil.example" })
    expect(r.status).toBe(403)
  })

  it("caps concurrent streams per device", async () => {
    const { port, a } = await boot({ maxStreamsPerDevice: 1 })
    const held = new Promise<IncomingMessage>(resolve => {
      const req = get({ host: "127.0.0.1", port, path: "/live/work", headers: auth(a) }, res => resolve(res))
      req.on("error", () => {})
    })
    const first = await held
    expect(first.statusCode).toBe(200)
    const second = await rawRequest(port, "GET", "/live/work", auth(a))
    expect(second.status).toBe(429)
    first.destroy()
  })

  it("stays out of the POST body path: a POST body is never read as a command", async () => {
    const { port, a, grabs } = await boot()
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/live/work", method: "POST", headers: auth(a) }, res => {
        res.resume()
        res.on("end", resolve)
      })
      req.on("error", reject)
      req.end(JSON.stringify({ click: [1, 2] }))
    })
    expect(grabs.n).toBe(0)
  })
})

describe("pairing tunnel", () => {
  it("forwards /live/* to a remote device, next to /mcp and /health", () => {
    expect(REMOTE_ALLOW_PATHS).toEqual(["/mcp", "/health", "/live/*"])
  })
})
