/**
 * Shared MCP-tool primitives for the bureau capability server — the normalised
 * `McpEntry` shape both tool families collapse to, the `McpContentBlock` union it
 * returns, and the two tiny converters (`asContent`, `toInputSchema`) every tool
 * uses. Factored out of `serve.ts` so the hand-rolled control tools build on the
 * SAME entry shape without importing the server bootstrap. (The social_* tools
 * now come from the AIP `buildMcpTool` bridge, adapted via `asMcpEntry`.)
 */

import { z } from "zod"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"

/** An MCP content block — text, or an embedded binary resource (recording bytes
 *  ride home in one of these so a remote host can land them). */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource"
      resource: { uri: string; mimeType: string; blob: string }
    }

/** One MCP tool, normalised — both families collapse to this so the request
 *  handlers never branch on which family a tool came from. */
export interface McpEntry {
  name: string
  description: string
  jsonSchema: Tool["inputSchema"]
  call: (
    args: Record<string, unknown>
  ) => Promise<{ content: McpContentBlock[] }>
}

/**
 * Convert a Zod schema to the JSON Schema an MCP client reads off `tools/list`.
 * Uses Zod's INPUT view (`io: "input"`) so a field carrying a `.default()` is
 * advertised as OPTIONAL — its absence is filled by the default at parse time.
 * The output view (Zod's default) would mark every defaulted field `required`,
 * forcing every caller to re-send values the server already supplies.
 */
export const toInputSchema = (schema: z.ZodType): Tool["inputSchema"] =>
  z.toJSONSchema(schema, { io: "input" }) as Tool["inputSchema"]

/** Wrap any handler result as a single MCP text content block (JSON-stringified
 *  unless it's already a string). */
export const asContent = (result: unknown): { content: McpContentBlock[] } => ({
  content: [
    {
      type: "text",
      text:
        typeof result === "string" ? result : JSON.stringify(result, null, 2),
    },
  ],
})
