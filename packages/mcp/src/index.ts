/**
 * @agentproto/bureau-mcp
 *
 * One MCP catalogue over the whole browser stack. Tools are assembled from
 * injected building blocks so the same catalogue runs in-process (light
 * drivers) or hosted by apps/service (heavy Chromium) — mirror corpus
 * cloud+local. Driver registry, scrape router, and stores are injected.
 *
 * Tool families:
 *  - scrape / extract                   ← the tiered scrape layer (router)
 *  - browser_* control                  ← core's createBrowserMcpTools, bound to a
 *                                          driver resolved from the registry by `target`
 *  - screencast / record / inspect_*     ← driver mixins + store (follow-on)
 *
 * The server resolves a driver per `target` kind via the registry
 * (extension/camofox/headless/mcp/…), attaches once, caches it — one server,
 * N backends, polymorphic (no kind switch at the call site).
 */

import { z } from "zod"
import {
  createBrowserMcpTools,
  type BrowserDriver,
  type BrowserDriverKind,
} from "@agentproto/bureau-core/driver"
import { writeArtifact } from "@agentproto/bureau-core/artifacts"
import { purify } from "@agentproto/bureau-purify"
import type { BrowserDriverRegistry } from "@agentproto/bureau-drivers"
import type {
  TieredScrapeRouter,
  ScrapeRequest,
} from "@agentproto/bureau-router"

/** Minimal MCP tool descriptor — name + schema + handler. */
export interface BrowserMcpToolDescriptor {
  name: string
  description: string
  inputSchema: z.ZodType
  handler: (args: unknown) => Promise<unknown>
}

export interface BrowserMcpDeps {
  /**
   * Tiered scrape router (escalating backends). Powers scrape/extract.
   * Optional — omit it for a control-only capability server (just the driver
   * registry); the scrape family then contributes no tools.
   */
  router?: TieredScrapeRouter
  /** Driver registry — resolves a backend per `target` for the control tools. */
  registry?: BrowserDriverRegistry
  /** Kind to use when a control call omits `target`. */
  defaultKind?: BrowserDriverKind
}

const scrapeInput = z.object({
  url: z.string(),
  /** Optional extraction schema (field → hint). */
  schema: z.record(z.string(), z.string()).optional(),
  /** Force a specific backend instead of auto-escalation. */
  engine: z.string().optional(),
  budget: z
    .object({
      maxTier: z.number().optional(),
      maxLlmCalls: z.number().optional(),
      maxCostUsd: z.number().optional(),
    })
    .optional(),
  /**
   * Purify the fetched HTML into clean Markdown (`{ title, markdown }`)
   * via Defuddle. Default true; pass false to get only the raw `html`.
   */
  purify: z.boolean().optional(),
})

/** The tiered `scrape` tool — auto-escalates across backends, optional schema/engine/budget. */
export function createScrapeTools(
  deps: BrowserMcpDeps
): BrowserMcpToolDescriptor[] {
  const router = deps.router
  if (!router) return []
  return [
    {
      name: "scrape",
      description:
        "Fetch a URL's content, auto-escalating HTTP → browser → stealth → agent on real " +
        "failure signals. Pass `schema` to extract structured fields; `engine` to force a " +
        "backend; `budget` to cap tier/cost/LLM calls.",
      inputSchema: scrapeInput,
      handler: async args => {
        const input = scrapeInput.parse(args)
        const req: ScrapeRequest = {
          schema: input.schema,
          profileHint: input.engine,
          budget: input.budget as ScrapeRequest["budget"],
        }
        const result = await router.scrape(input.url, req)
        // Enrich with clean Markdown so consumers get reading material, not
        // raw HTML. The router stays fetch-only; purification composes here.
        // A purify failure must not fail the scrape — fall back to raw html.
        if (input.purify !== false && result.html) {
          try {
            const { title, markdown } = await purify(result.html, input.url)
            return { ...result, title, markdown }
          } catch {
            return result
          }
        }
        return result
      },
    },
  ]
}

/**
 * `browser_*` control tools (navigate/click/fill/evaluate/screenshot/get_dom/…)
 * bound to a driver resolved from the registry. Each tool takes an optional
 * `target` (the driver kind); drivers are attached once and cached per kind.
 */
export function createControlTools(
  deps: BrowserMcpDeps
): BrowserMcpToolDescriptor[] {
  const registry = deps.registry
  if (!registry) return []
  const reg: BrowserDriverRegistry = registry

  const sessions = new Map<string, BrowserDriver>()
  async function resolveDriver(target?: string): Promise<BrowserDriver> {
    const kind = (target ?? deps.defaultKind) as BrowserDriverKind | undefined
    if (!kind)
      throw new Error(
        "browser control: no `target` kind and no defaultKind set"
      )
    const cached = sessions.get(kind)
    if (cached && !cached.closed) return cached
    const provider = reg.get(kind)
    if (!provider)
      throw new Error(
        `browser control: no driver registered for kind "${kind}"`
      )
    const driver = await provider.attach({})
    sessions.set(kind, driver)
    return driver
  }

  return createBrowserMcpTools({ writeArtifact }).map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as z.ZodType,
    handler: async (args: unknown) => {
      const { target, ...rest } = (args ?? {}) as { target?: string }
      const driver = await resolveDriver(target)
      return tool.handler(rest, driver)
    },
  }))
}

/** Assemble the full browser MCP catalogue (scrape + control families). */
export function createBrowserMcpCatalogue(
  deps: BrowserMcpDeps
): BrowserMcpToolDescriptor[] {
  return [...createScrapeTools(deps), ...createControlTools(deps)]
}

export interface BrowserMcpServer {
  listTools(): Array<{
    name: string
    description: string
    inputSchema: z.ZodType
  }>
  callTool(name: string, args: unknown): Promise<unknown>
}

/**
 * Build the browser MCP server. Mount it in-process (light drivers) or host it
 * in apps/service (heavy Chromium) — same catalogue, deps injected.
 */
export function createBrowserMcpServer(deps: BrowserMcpDeps): BrowserMcpServer {
  const tools = createBrowserMcpCatalogue(deps)
  const byName = new Map(tools.map(t => [t.name, t]))
  return {
    listTools() {
      return tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }))
    },
    async callTool(name, args) {
      const tool = byName.get(name)
      if (!tool) throw new Error(`browser-mcp: unknown tool "${name}"`)
      return tool.handler(args)
    },
  }
}

export type { TieredScrapeRouter } from "@agentproto/bureau-router"
export type { BrowserDriverRegistry } from "@agentproto/bureau-drivers"
