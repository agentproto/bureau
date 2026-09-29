import { createServer } from "node:net"
import { request } from "node:http"

/** A free 127.0.0.1 port (the Host allowlist needs the port before listen). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

export interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

export function rawRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        })
      )
    })
    req.on("error", reject)
    req.end(body)
  })
}

export const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
} as const

/** One JSON-RPC call to /mcp with an optional bearer. */
export function mcpCall(
  port: number,
  method: string,
  params: Record<string, unknown> = {},
  bearer?: string
): Promise<RawResponse> {
  return rawRequest(
    port,
    "POST",
    "/mcp",
    { ...MCP_HEADERS, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  )
}
