/**
 * Server-side JSON-RPC 2.0 adapter that exposes a `BrowserDriverProvider`
 * (typically `HeadlessBrowserDriverProvider`) through the same `handle()`
 * surface the extension-side `ExtensionBrowserMcpServer` uses.
 *
 * Lets headless drivers plug into any consumer that already speaks the tunnel
 * MCP dialect — in-process, no HTTP server, no extra wire framing.
 */

import type { JsonRpcRequest, JsonRpcResponse } from "../protocol/json-rpc.js"
import {
  createBrowserMcpTools,
  toMcpToolDescriptors,
  type ArtifactWriter,
  type BrowserMcpTool,
} from "./mcp-tools.js"
import type {
  AttachOptions,
  BrowserDriver,
  BrowserDriverProvider,
} from "./types.js"

export interface BrowserMcpServerAdapterOptions {
  /** Forwarded to provider.attach() on first tool call. */
  attach?: AttachOptions
  /** Override the advertised serverInfo.name (defaults to provider.kind). */
  serverName?: string
  /**
   * Host artifact writer for `browser_screenshot`/export `path` outputs. Inject
   * `writeArtifact` from `@agentproto/bureau-core/artifacts` (Node-only). Omit on
   * hosts without a filesystem — `path` outputs then error and base64 is used.
   */
  writeArtifact?: ArtifactWriter
}

export class BrowserMcpServerAdapter {
  private readonly tools: BrowserMcpTool[]
  private readonly toolByName: Map<string, BrowserMcpTool>
  private driver: BrowserDriver | null = null
  private driverPromise: Promise<BrowserDriver> | null = null

  constructor(
    private readonly provider: BrowserDriverProvider,
    private readonly options: BrowserMcpServerAdapterOptions = {}
  ) {
    this.tools = createBrowserMcpTools({
      writeArtifact: this.options.writeArtifact,
    })
    this.toolByName = new Map(this.tools.map(t => [t.name, t]))
  }

  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id ?? null
    try {
      switch (req.method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              serverInfo: {
                name:
                  this.options.serverName ?? `browser-${this.provider.kind}`,
                version: "0.1.0",
              },
              capabilities: { tools: {} },
            },
          }
        case "tools/list":
          return {
            jsonrpc: "2.0",
            id,
            result: { tools: toMcpToolDescriptors(this.tools) },
          }
        case "tools/call": {
          const params = req.params as
            | { name?: unknown; arguments?: unknown }
            | undefined
          const name = typeof params?.name === "string" ? params.name : ""
          if (!name) {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message:
                  "Invalid params: tools/call requires { name: string, arguments?: unknown }",
              },
            }
          }
          const args = params?.arguments
          const tool = this.toolByName.get(name)
          if (!tool) throw new Error(`Unknown tool: ${name}`)
          const driver = await this.getDriver()
          const result = await tool.handler(args ?? {}, driver)
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result) }],
            },
          }
        }
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          }
      }
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }

  private async getDriver(): Promise<BrowserDriver> {
    if (this.driver && !this.driver.closed) return this.driver
    if (this.driverPromise) return this.driverPromise
    this.driverPromise = this.provider
      .attach(this.options.attach ?? {})
      .then(d => {
        this.driver = d
        return d
      })
      .finally(() => {
        this.driverPromise = null
      })
    return this.driverPromise
  }

  async close(): Promise<void> {
    if (this.driver && !this.driver.closed) await this.driver.close()
    this.driver = null
  }
}
