import { afterEach, describe, expect, it } from "vitest"
import { request, type Server as HttpServer } from "node:http"
import { allowLoopback, createBureauHttpServer } from "./mcp-server.js"
import type { McpEntry } from "../mcp-tool.js"

/** Post with an explicit `Host` header — `fetch`/undici treats `Host` as a
 *  forbidden header and silently sends the real one instead, so simulating a
 *  DNS-rebinding request (a forged `Host`) needs the lower-level `http`
 *  client, which allows it. */
function postWithHost(port: number, host: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      res => {
        res.resume()
        res.on("end", () => resolve(res.statusCode ?? 0))
      }
    )
    req.on("error", reject)
    req.end(body)
  })
}

const ENTRIES: McpEntry[] = [
  {
    name: "noop",
    description: "does nothing",
    jsonSchema: { type: "object", properties: {} },
    call: async () => ({ content: [{ type: "text", text: "{}" }] }),
  },
]

// A FIXED test port, not an OS-assigned ephemeral one (port 0): the Host
// allowlist createBureauHttpServer builds is keyed on the `port` passed to
// it, which must equal the port the server actually binds to — an ephemeral
// port resolved AFTER construction would never match.
const TEST_PORT = 18830

function listen(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })
}

function close(server: HttpServer): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

let server: HttpServer | undefined

afterEach(async () => {
  if (server) await close(server)
  server = undefined
})

describe("createBureauHttpServer — Host guard + authorize seam", () => {
  it("/health stays open with no Host/authorize gating", async () => {
    server = createBureauHttpServer({
      entries: ENTRIES,
      port: TEST_PORT,
      authorize: () => false, // even a hostile authorize must not touch /health
    })
    await listen(server, TEST_PORT)
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, tools: ENTRIES.length })
  })

  it("rejects a POST /mcp whose Host header is not the loopback allowlist (DNS rebinding)", async () => {
    server = createBureauHttpServer({
      entries: ENTRIES,
      port: TEST_PORT,
      authorize: allowLoopback,
    })
    await listen(server, TEST_PORT)
    const status = await postWithHost(TEST_PORT, "evil.com:1234", "{}")
    expect(status).toBe(403)
  })

  it("accepts a POST /mcp with a loopback Host and an explicit allowLoopback authorize (studio flavour)", async () => {
    server = createBureauHttpServer({
      entries: ENTRIES,
      port: TEST_PORT,
      authorize: allowLoopback,
    })
    await listen(server, TEST_PORT)
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    })
    expect(res.status).toBe(200)
  })

  it("rejects a POST /mcp when a custom authorize returns false", async () => {
    server = createBureauHttpServer({
      entries: ENTRIES,
      port: TEST_PORT,
      authorize: () => false,
    })
    await listen(server, TEST_PORT)
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(401)
  })

  it("allowLoopback is a plain function of the socket, not env/token-based", () => {
    // Regression guard for PLAN-FINAL.md L0: no static token/env-token scheme.
    expect(typeof allowLoopback).toBe("function")
    expect(allowLoopback.toString()).not.toMatch(/process\.env/)
  })
})
