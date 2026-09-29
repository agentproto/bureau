/**
 * The seam that lets ONE client serve every surface. A transport only has to
 * forward a `tools/call` to a Bureau and hand back the result blocks; how it
 * gets there is the host's business:
 *
 *   • local  → the packaged Bureau app talks to its own server on 127.0.0.1
 *   • tunnel → a host forwards over the daemon reverse-tunnel (callImportedMcp)
 *
 * Mirrors the local-daemon bridge result shape verbatim so a tunnel host can
 * adapt its bridge to this interface in three lines.
 */

export interface BureauToolResult {
  content: Array<{ type: string; text?: string; data?: unknown }>
  isError?: boolean
}

export interface BureauTransport {
  callTool(toolName: string, args?: unknown): Promise<BureauToolResult>
}

/**
 * Local-mode transport: a Bureau capability server runs its MCP endpoint
 * statelessly with JSON responses (no session handshake), so a single
 * `tools/call` POST returns the result inline — no MCP client runtime needed.
 * Defaults to the standard local port; pass `fetchImpl` for non-browser hosts.
 */
export function createHttpTransport(opts?: {
  baseUrl?: string
  fetchImpl?: typeof fetch
}): BureauTransport {
  const base = (opts?.baseUrl ?? "http://127.0.0.1:8830").replace(/\/+$/, "")
  const doFetch = opts?.fetchImpl ?? fetch
  let id = 0
  return {
    async callTool(toolName, args) {
      const res = await doFetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name: toolName, arguments: args ?? {} },
        }),
      })
      if (!res.ok) throw new Error(`bureau ${toolName}: HTTP ${res.status}`)
      const json = (await res.json()) as {
        result?: BureauToolResult
        error?: { message?: string }
      }
      if (json.error) {
        throw new Error(`bureau ${toolName}: ${json.error.message ?? "error"}`)
      }
      return json.result ?? { content: [] }
    },
  }
}
