import { describe, it, expect } from "vitest"
import { bureauEndpoint } from "./endpoint.js"

describe("bureauEndpoint", () => {
  it("defaults a bare host to TLS (cloud case) and tracks wss for watch", () => {
    const ep = bureauEndpoint("8830-abc.e2b.app")
    expect(ep.origin).toBe("https://8830-abc.e2b.app")
    expect(ep.mcpBase).toBe("https://8830-abc.e2b.app")
    expect(ep.watchUrl("tab-1")).toBe("wss://8830-abc.e2b.app/watch/tab-1")
  })

  it("honors an explicit http origin (local case) and uses ws for watch", () => {
    const ep = bureauEndpoint("http://127.0.0.1:8830")
    expect(ep.mcpBase).toBe("http://127.0.0.1:8830")
    expect(ep.watchUrl("t")).toBe("ws://127.0.0.1:8830/watch/t")
  })

  it("strips trailing slashes from the MCP base", () => {
    expect(bureauEndpoint("https://h/").mcpBase).toBe("https://h")
  })

  it("encodes the tab id and appends stream options", () => {
    const ep = bureauEndpoint("https://h")
    expect(ep.watchUrl("a/b c")).toBe("wss://h/watch/a%2Fb%20c")
    expect(ep.watchUrl("t", { format: "png", quality: 80, fps: 12 })).toBe(
      "wss://h/watch/t?format=png&quality=80&fps=12"
    )
  })

  it("normalizes a ws/wss origin back to the http(s) MCP base", () => {
    expect(bureauEndpoint("wss://h:1/").mcpBase).toBe("https://h:1")
    expect(bureauEndpoint("ws://h:2").watchUrl("t")).toBe("ws://h:2/watch/t")
  })

  it("exposes a transport that posts to <mcpBase>/mcp", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response(
        JSON.stringify({ result: { content: [{ type: "text", text: "ok" }] } }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    }) as unknown as typeof fetch

    const ep = bureauEndpoint("https://8830-abc.e2b.app")
    const result = await ep
      .transport({ fetchImpl: fakeFetch })
      .callTool("bureau_tabs", { foo: 1 })

    expect(calls[0]?.url).toBe("https://8830-abc.e2b.app/mcp")
    expect(result.content[0]?.text).toBe("ok")
  })
})
