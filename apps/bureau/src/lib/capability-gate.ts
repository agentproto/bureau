/**
 * Capability-gated tool errors. ONE table maps a browser capability to the
 * Bureau tools that need it. When the active browser lacks the capability the
 * tool answers with a typed `browser:unsupported` error naming the capability,
 * the active browser and the browsers that do have it, instead of a generic
 * failure from deep inside a driver.
 *
 * The check is by manifest flag (`hasCapability`), never by provider id, so a
 * third-party provider that declares `cdp: true` unlocks the CDP tools.
 */

import {
  BROWSER_UNSUPPORTED_CODE,
  hasCapability,
  type BrowserCapabilityName,
  type BrowserProvider,
  type BrowserRegistry,
} from "@agentproto/driver-browser"
import type { McpEntry } from "../mcp-tool.js"

export type CapabilityToolTable = Readonly<Partial<Record<BrowserCapabilityName, readonly string[]>>>

/** capability -> the Bureau tools that need it. The single source of truth. */
export const CAPABILITY_TOOL_TABLE: CapabilityToolTable = Object.freeze({
  // Network capture and raw protocol access exist only on a CDP browser.
  cdp: Object.freeze(["browser_list_requests", "browser_get_request_body", "browser_cdp_send"]),
  // A same-tab file download capture.
  downloads: Object.freeze(["browser_download"]),
  // These tools promise a stealth browser in their contract.
  stealth: Object.freeze(["scrape", "browser_act"]),
})

/** The wire body of a capability error, as carried in the tool result text. */
export interface CapabilityErrorBody {
  code: typeof BROWSER_UNSUPPORTED_CODE
  error: string
  tool: string
  capability: BrowserCapabilityName
  browser: string
  alternatives: string[]
}

/** Invert the table (plus extras) to tool -> capability. A tool in two rows keeps the first. */
export function toolCapabilityIndex(
  table: CapabilityToolTable = CAPABILITY_TOOL_TABLE,
  extra: Readonly<Record<string, BrowserCapabilityName>> = {}
): Map<string, BrowserCapabilityName> {
  const index = new Map<string, BrowserCapabilityName>()
  for (const [cap, tools] of Object.entries(table) as [BrowserCapabilityName, readonly string[]][])
    for (const tool of tools) if (!index.has(tool)) index.set(tool, cap)
  for (const [tool, cap] of Object.entries(extra)) if (!index.has(tool)) index.set(tool, cap)
  return index
}

/** Ids of the registered browsers (other than `active`) that have the capability. */
export function alternativesFor(
  registry: BrowserRegistry,
  capability: BrowserCapabilityName,
  active: string
): string[] {
  return registry
    .list()
    .filter(p => p.id !== active && hasCapability(p.capabilities, capability))
    .map(p => p.id)
}

export function capabilityErrorBody(
  tool: string,
  capability: BrowserCapabilityName,
  active: BrowserProvider,
  registry: BrowserRegistry
): CapabilityErrorBody {
  const alternatives = alternativesFor(registry, capability, active.id)
  const use =
    alternatives.length > 0
      ? `Restart Bureau with one that does: bureau start --browser ${alternatives.join(" | ")}.`
      : "No registered browser has it."
  return {
    code: BROWSER_UNSUPPORTED_CODE,
    error: `"${tool}" needs the "${capability}" capability, which the active browser "${active.id}" does not have. ${use}`,
    tool,
    capability,
    browser: active.id,
    alternatives,
  }
}

export interface CapabilityGateOptions {
  active: BrowserProvider
  registry: BrowserRegistry
  table?: CapabilityToolTable
  /** Tool to capability pairs contributed by plugins. */
  extra?: Readonly<Record<string, BrowserCapabilityName>>
}

/** Wrap the entries whose capability the active browser lacks. Others pass through untouched. */
export function gateEntriesByCapability(entries: McpEntry[], opts: CapabilityGateOptions): McpEntry[] {
  const index = toolCapabilityIndex(opts.table, opts.extra)
  return entries.map(entry => {
    const capability = index.get(entry.name)
    if (capability === undefined || hasCapability(opts.active.capabilities, capability)) return entry
    const body = capabilityErrorBody(entry.name, capability, opts.active, opts.registry)
    return {
      ...entry,
      call: async () => ({
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(body) }],
      }),
    }
  })
}
