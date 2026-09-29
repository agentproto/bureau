/**
 * The plugin seam. Core is a small MCP server over a real browser; everything
 * private (social, capture, research, screen control, cloud sessions, billing,
 * the private recipe catalogue) arrives as a {@link BureauPlugin} that a
 * composition root passes to `buildCatalogue`, or that `bureau serve --plugin
 * <path|pkg>` / `BUREAU_PLUGINS=a,b` loads at startup.
 *
 * Loading is fail-loud by design: a plugin that can't be imported, has the wrong
 * shape, throws while building its tools, or fails its license check aborts
 * startup with a {@link PluginLoadError} naming it. A silently dropped plugin
 * would look like a healthy server that quietly lost tools.
 */

import { isAbsolute, resolve as resolvePath } from "node:path"
import { pathToFileURL } from "node:url"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { SessionStorePort } from "@agentproto/browser-profiles"
import { BROWSER_CAPABILITY_NAMES, type BrowserCapabilityName, type BrowserProvider } from "@agentproto/driver-browser"
import type { BrowserMcpToolDescriptor } from "@agentproto/bureau-mcp"
import type { McpEntry } from "./mcp-tool.js"
import type { Authorize } from "./lib/mcp-server.js"
import type { CredentialStorePort } from "./lib/credentials.js"
import type { HumanSession, SessionResolver } from "./lib/ports.js"
import type { RecipeRegistry } from "./lib/recipe-registry.js"
import type { WorkflowHooks } from "./lib/workflow-hooks.js"
import type { BureauSessionDeps, SessionSource } from "./lib/sessions.js"
import { registerSessionSource } from "./lib/sessions.js"

export type { SessionSource }
export { allowLoopback, type Authorize, type AuthDecision } from "./lib/mcp-server.js"
export { currentDevice, type DeviceIdentity } from "./lib/device-context.js"

/** Outcome of a plugin's license check. */
export type LicenseResult = { ok: true; tier?: string } | { ok: false; reason: string }

/** Called once at load; `{ok:false}` refuses the plugin. */
export type LicenseCheck = () => LicenseResult | Promise<LicenseResult>

/** One completed tool call, as reported to a {@link UsageMeter}. */
export interface UsageEvent {
  tool: string
  plugin?: string
  ok: boolean
  ms: number
}

/** Optional usage reporting; core's default discards everything. */
export interface UsageMeter {
  record(event: UsageEvent): void | Promise<void>
}

export const noopUsageMeter: UsageMeter = { record: () => {} }

/** What core hands a plugin so it can build tools over the shared runtime. */
export interface PluginContext {
  /** Saved-session store (layered over any registered managed source). */
  store: SessionStorePort
  /** Managed-session wiring resolved from the registered session sources. */
  sessionDeps: BureauSessionDeps
  credStore: CredentialStorePort
  /** Session resolver whose live sessions are shared with `browser_act`. */
  pooledResolver: SessionResolver
  /** Get-or-create the pooled live session for an id. */
  resolvePooledDriver: (id: string) => Promise<HumanSession>
  /** Drop a session from the active pool (after its state changed on disk). */
  evictActiveDriver: (id: string) => void
  /** The raw control tools (navigate / evaluate / get_dom / screenshot …) by
   *  name, for plugin tools that compose them without MCP content blocks. */
  controlTools: ReadonlyMap<string, BrowserMcpToolDescriptor>
  /** Add recipes to the registry `bureau_workflow_list/run` serve. */
  recipes: RecipeRegistry
  workflow: { set(patch: Partial<WorkflowHooks>): void }
  usage: UsageMeter
  log: (line: string) => void
}

export interface BureauPlugin {
  name: string
  /** Build this plugin's MCP tools. May register recipes / workflow hooks. */
  entries(ctx: PluginContext): McpEntry[]
  /** Extra HTTP routes tried before MCP (return true when handled). */
  httpRoutes?: (req: IncomingMessage, res: ServerResponse) => boolean
  /** Extra CLI subcommands, consulted for names core doesn't know. */
  commands?: Record<string, (argv: string[]) => Promise<number>>
  /** Managed-session providers, registered before the catalogue is built. */
  sessionSources?: SessionSource[]
  license?: LicenseCheck
  /** Replaces the OSS pairing authorize on `/mcp` (the studio flavour supplies
   *  `allowLoopback`). At most one loaded plugin may set it. */
  authorize?: Authorize
  /** Browser providers (kit `defineBrowser`), registered next to camofox / chrome /
   *  chromium and selectable by id: `bureau start --browser <id>`. */
  browsers?: BrowserProvider[]
  /** Tools of this plugin that need a browser capability (tool name to
   *  capability). Merged into the capability gate table, so the tool returns a
   *  typed `browser:unsupported` error on a browser that lacks it. */
  toolCapabilities?: Record<string, BrowserCapabilityName>
}

export class PluginLoadError extends Error {
  constructor(
    readonly spec: string,
    detail: string
  ) {
    super(`bureau plugin "${spec}" failed to load: ${detail}`)
    this.name = "PluginLoadError"
  }
}

const detailOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

/** Structural check; returns a description of the first problem, else undefined. */
export function pluginShapeProblem(p: unknown): string | undefined {
  if (!p || typeof p !== "object") return "export is not a plugin object"
  const o = p as Record<string, unknown>
  if (typeof o.name !== "string" || !o.name.trim()) return "missing string `name`"
  if (typeof o.entries !== "function") return "missing `entries(ctx)` function"
  for (const k of ["httpRoutes", "license", "authorize"] as const) {
    if (o[k] !== undefined && typeof o[k] !== "function")
      return `\`${k}\` must be a function`
  }
  if (o.commands !== undefined) {
    if (!o.commands || typeof o.commands !== "object")
      return "`commands` must be an object"
    for (const [c, fn] of Object.entries(o.commands))
      if (typeof fn !== "function") return `command "${c}" must be a function`
  }
  if (o.browsers !== undefined) {
    if (!Array.isArray(o.browsers)) return "`browsers` must be an array"
    for (const b of o.browsers as unknown[]) {
      const r = b as Record<string, unknown> | null
      if (!r || typeof r.id !== "string" || typeof r.launch !== "function")
        return "each browser needs a string `id` and a `launch()` function"
    }
  }
  if (o.toolCapabilities !== undefined) {
    if (!o.toolCapabilities || typeof o.toolCapabilities !== "object" || Array.isArray(o.toolCapabilities))
      return "`toolCapabilities` must be an object"
    for (const [tool, cap] of Object.entries(o.toolCapabilities))
      if (!(BROWSER_CAPABILITY_NAMES as readonly string[]).includes(cap as string))
        return `toolCapabilities["${tool}"] is not a browser capability`
  }
  if (o.sessionSources !== undefined) {
    if (!Array.isArray(o.sessionSources)) return "`sessionSources` must be an array"
    for (const s of o.sessionSources as unknown[]) {
      const r = s as Record<string, unknown> | null
      if (!r || typeof r.name !== "string" || typeof r.deps !== "function")
        return "each session source needs a `name` and a `deps()` function"
    }
  }
  return undefined
}

/** Split `--plugin a --plugin b` flags and `BUREAU_PLUGINS=a,b` into specs. */
export function pluginSpecs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--plugin") {
      const v = argv[i + 1]
      if (v && !v.startsWith("--")) out.push(v)
      i++
    } else if (a?.startsWith("--plugin=")) {
      out.push(a.slice("--plugin=".length))
    }
  }
  for (const s of (env.BUREAU_PLUGINS ?? "").split(",")) {
    const t = s.trim()
    if (t) out.push(t)
  }
  return [...new Set(out)]
}

function importTarget(spec: string): string {
  if (spec.startsWith("file:")) return spec
  if (spec.startsWith(".") || isAbsolute(spec))
    return pathToFileURL(resolvePath(spec)).href
  return spec
}

/** Load one plugin spec (relative/absolute path, file URL, or package name). */
export async function loadPlugin(spec: string): Promise<BureauPlugin> {
  let mod: Record<string, unknown>
  try {
    mod = (await import(importTarget(spec))) as Record<string, unknown>
  } catch (e) {
    throw new PluginLoadError(spec, detailOf(e))
  }
  let exported = mod.default ?? mod.plugin ?? mod.bureauPlugin
  if (typeof exported === "function") {
    try {
      exported = await (exported as () => unknown)()
    } catch (e) {
      throw new PluginLoadError(spec, `factory threw: ${detailOf(e)}`)
    }
  }
  const problem = pluginShapeProblem(exported)
  if (problem) throw new PluginLoadError(spec, problem)
  const plugin = exported as BureauPlugin
  await checkLicense(plugin, spec)
  return plugin
}

/** Run a plugin's license check; a refusal or a throw is a load failure. */
export async function checkLicense(
  plugin: BureauPlugin,
  spec: string = plugin.name
): Promise<void> {
  if (!plugin.license) return
  let result: LicenseResult
  try {
    result = await plugin.license()
  } catch (e) {
    throw new PluginLoadError(spec, `license check threw: ${detailOf(e)}`)
  }
  if (!result.ok) throw new PluginLoadError(spec, `license refused: ${result.reason}`)
}

/** Load every spec in order; the first failure rejects (fail loud). */
export async function loadPlugins(
  specs: readonly string[]
): Promise<BureauPlugin[]> {
  const out: BureauPlugin[] = []
  for (const spec of specs) out.push(await loadPlugin(spec))
  return out
}

/** Register the plugins' session sources (idempotent, by source name). Called
 *  by the catalogue builder and by the CLI before non-serve commands run. */
export function activatePlugins(plugins: readonly BureauPlugin[]): void {
  for (const p of plugins) for (const s of p.sessionSources ?? []) registerSessionSource(s)
}
