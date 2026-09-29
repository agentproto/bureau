/**
 * Bureau capability server — the installable daemon.
 *
 * Owns the (stealth) browser session and exposes its capabilities as MCP tools
 * over HTTP, so an operator agent (local CLI or a connected cloud)
 * drives a real browser through one polymorphic seam. Vendor-neutral — depends
 * only on the Bureau libraries, @agentproto/* and the standard MCP SDK, no app refs.
 *
 * Core is the open browser server: CONTROL (navigate / click / fill / evaluate /
 * screenshot / get_dom over the Camofox stealth driver), scrape, download,
 * browser_act, session introspection and the workflow engine with two sample
 * recipes. Everything else (social, capture, research, screen control, cloud
 * sessions, billing, the private recipes) is a {@link BureauPlugin} passed to
 * `buildCatalogue` / `runServe`, or loaded with `--plugin` / `BUREAU_PLUGINS`.
 *
 *   env: CAMOFOX_URL (default http://127.0.0.1:9377), PORT (default 8830)
 *
 * Tool catalogue split across focused modules in lib/:
 *   control    — browser_navigate / click / fill / evaluate / screenshot / …
 *   scrape     — scrape
 *   download   — browser_download (captures a same-tab file download)
 *   act        — browser_act (interactive session-bound driver)
 *   workflow   — bureau_workflow_list / run
 *   introspect — bureau_sessions / bureau_tabs
 *   sync       — session_sync_from_chrome
 */

import { createBrowserDriverRegistry } from "@agentproto/bureau-drivers"
import {
  createCamofoxRestClient,
  registerCamofoxDriver,
} from "@agentproto/bureau-drivers/camofox"
import { createBrowserMcpCatalogue } from "@agentproto/bureau-mcp"
import type { IncomingMessage, ServerResponse } from "node:http"
import { asContent, toInputSchema, type McpEntry } from "./mcp-tool.js"
import {
  sessionResolver,
  sessionStore,
  sessionVerifier,
  bureauSessionDeps,
} from "./lib/sessions.js"
import {
  createActiveDriverPool,
  createActEntry,
  createSessionAwareControlEntries,
} from "./lib/active-driver-pool.js"
import { createIntrospectionEntries } from "./lib/introspection-tools.js"
import { createSyncEntry } from "./lib/sync-tools.js"
import { keychainCredentialStore } from "./lib/credentials.js"
import { createScrapeEntries } from "./lib/scrape-tools.js"
import { createDownloadEntry } from "./lib/download-tools.js"
import { createWorkflowEntries } from "./lib/workflow-tools.js"
import { createBureauHttpServer } from "./lib/mcp-server.js"
import { recipeRegistry } from "./lib/recipe-registry.js"
import { setWorkflowHooks } from "./lib/workflow-hooks.js"
import { registerSampleRecipes } from "./recipes/index.js"
import { attachWatch } from "./lib/watch.js"
import { boolEnv, parseArgs } from "./lib/args.js"
import {
  PluginLoadError,
  activatePlugins,
  checkLicense,
  loadPlugins,
  noopUsageMeter,
  pluginSpecs,
  type BureauPlugin,
  type PluginContext,
  type UsageMeter,
} from "./plugin.js"

/** camofox userId for bare (non-session) control operations (browser_navigate, scrape). */
const CONTROL_USER_ID = "main"

/** Everything `runServe` needs to start listening — split out so a test can
 *  build the SAME offline catalogue `runServe` would (names, schemas) without
 *  opening a port or touching a live camofox (L0 snapshot-vs-catalogue test,
 *  PLAN-FINAL.md F6: the golden snapshot in
 *  `src/__tests__/golden/tool-catalogue.snapshot.json` must match what this
 *  function actually registers, core plus the studio plugin). */
export interface BureauCatalogue {
  entries: McpEntry[]
  /** Plugin HTTP routes, tried before MCP (undefined when no plugin has any). */
  extraRoutes?: (req: IncomingMessage, res: ServerResponse) => boolean
  store: ReturnType<typeof sessionStore>
  camofox: ReturnType<typeof createCamofoxRestClient>
}

export interface CatalogueOptions {
  plugins?: readonly BureauPlugin[]
  usage?: UsageMeter
}

/** Build the full tool catalogue — every entry `runServe` registers, minus
 *  the actual `.listen()`. No network I/O happens just from calling this: the
 *  camofox REST client and every session/credential store are lazy objects
 *  that only touch the network/OS on first use. A plugin whose `entries()`
 *  throws, or that reuses a tool name, aborts with a {@link PluginLoadError}. */
export function buildCatalogue(opts: CatalogueOptions = {}): BureauCatalogue {
  const plugins = opts.plugins ?? []
  const usage = opts.usage ?? noopUsageMeter

  // Session sources first: `bureauSessionDeps()` below reads them.
  activatePlugins(plugins)
  registerSampleRecipes(recipeRegistry)

  // ── Driver registry ────────────────────────────────────────────────────────
  const registry = createBrowserDriverRegistry()
  const camofox = createCamofoxRestClient({
    baseUrl: process.env.CAMOFOX_URL,
    userId: CONTROL_USER_ID,
    apiKey: process.env.CAMOFOX_API_KEY,
  })
  registerCamofoxDriver(registry, { client: camofox })

  // ── Control catalogue ──────────────────────────────────────────────────────
  // Raw BrowserMcpToolDescriptor[] from the vendor-neutral catalogue; also kept
  // as a Map so scrape can compose navigate/evaluate without going through MCP
  // content blocks.
  const controlCatalogue = createBrowserMcpCatalogue({
    registry,
    defaultKind: "camofox",
  })
  const controlEntries: McpEntry[] = controlCatalogue.map(t => ({
    name: t.name,
    description: t.description,
    jsonSchema: toInputSchema(t.inputSchema),
    call: async args => asContent(await t.handler(args)),
  }))
  const ctlByName = new Map(controlCatalogue.map(t => [t.name, t]))

  // ── Session layer ──────────────────────────────────────────────────────────
  // sessionDeps carries whatever managed-session source a plugin registered;
  // store is the identity catalog (bureau_sessions / bureau_tabs / scrape with
  // session).
  const sessionDeps = bureauSessionDeps()
  const store = sessionStore(sessionDeps)
  const credStore = keychainCredentialStore()

  // ── Active driver pool ─────────────────────────────────────────────────────
  // Keeps HumanSessions alive across consecutive browser_act calls for the
  // same session id. Also provides pooledResolver for plugin tools so action
  // chains share the same live tab as browser_act. `log` surfaces the pool's
  // self-heal lines (backend restart / launch-coincident retry —
  // lib/backend-health.ts) on stdout, same channel as the boot line below.
  const log = (s: string): void => {
    // eslint-disable-next-line no-console
    console.log(s)
  }
  const base = sessionResolver(sessionDeps)
  const { resolvePooledDriver, pooledResolver, pool } = createActiveDriverPool(
    base,
    { log }
  )

  // browser_navigate / browser_evaluate are otherwise permanently bound to the
  // anonymous "main" camofox tab (see createSessionAwareControlEntries doc) —
  // wrap them so a `session` arg routes through the same pool as browser_act,
  // landing on the session's own cookie-injected tab instead of a guest one.
  const sessionAwareControlEntries = createSessionAwareControlEntries(
    controlEntries,
    resolvePooledDriver,
    pool,
    log
  )

  // ── Catalogue assembly (core) ──────────────────────────────────────────────
  const entries: McpEntry[] = [
    ...sessionAwareControlEntries,
    ...createScrapeEntries({ ctlByName, sessionDeps }),
    createActEntry(resolvePooledDriver, pool, log),
    createDownloadEntry({ resolvePooledDriver }),
    ...createWorkflowEntries(),
    ...createIntrospectionEntries({
      store,
      camofox,
      creds: credStore,
      verifySession: sessionVerifier(sessionDeps, store),
    }),
    createSyncEntry({ store }),
  ]

  // ── Plugins ────────────────────────────────────────────────────────────────
  const ctx: PluginContext = {
    store,
    sessionDeps,
    credStore,
    pooledResolver,
    resolvePooledDriver,
    evictActiveDriver: id => pool.delete(id),
    controlTools: ctlByName,
    recipes: recipeRegistry,
    workflow: { set: setWorkflowHooks },
    usage,
    log,
  }
  const owner = new Map<string, string>(entries.map(e => [e.name, "core"]))
  for (const plugin of plugins) {
    let built: McpEntry[]
    try {
      built = plugin.entries(ctx)
    } catch (e) {
      throw new PluginLoadError(
        plugin.name,
        `entries() threw: ${e instanceof Error ? e.message : String(e)}`
      )
    }
    for (const entry of built) {
      const prior = owner.get(entry.name)
      if (prior !== undefined)
        throw new PluginLoadError(
          plugin.name,
          `tool "${entry.name}" is already registered by ${prior}`
        )
      owner.set(entry.name, plugin.name)
      entries.push(entry)
    }
  }

  const routes = plugins.flatMap(p => (p.httpRoutes ? [p.httpRoutes] : []))
  const extraRoutes =
    routes.length > 0
      ? (req: IncomingMessage, res: ServerResponse): boolean =>
          routes.some(route => route(req, res))
      : undefined

  return { entries, extraRoutes, store, camofox }
}

/** Parse `--host <h>` (else `$BUREAU_HOST`, else `127.0.0.1`) — the default
 *  loopback bind is F1/Decision 5 (Bureau used to bind all interfaces with no
 *  auth). Exported for the default-bind test. */
export function resolveHost(argv: string[] = []): string {
  const { flags } = parseArgs(argv)
  return flags.host || process.env.BUREAU_HOST || "127.0.0.1"
}

/** Boot the capability server: load plugins, build the catalogue, listen for
 *  MCP over HTTP. `argv` is the bureau-serve-specific arg tail (e.g.
 *  `["--host", "0.0.0.0", "--plugin", "./x.js"]`); `extraPlugins` are
 *  already-constructed plugins a composition root (the studio entrypoint) adds.
 *  Rejects, before any port is opened, when a plugin fails to load. */
export async function runServe(
  argv: string[] = [],
  extraPlugins: readonly BureauPlugin[] = []
): Promise<void> {
  // ── Process safety net ─────────────────────────────────────────────────────
  // The MCP SDK's per-request Server.close() can emit unhandled rejections
  // (e.g. trying to send on a transport that's already closed). Without these
  // handlers Node kills the daemon -> the 502/fetch-failed an operator sees
  // (salvage: refs/salvage/stash/2026-07-07-33, crash safety net). Registered
  // FIRST, before any startup work below, so a throw during catalogue
  // construction is still logged rather than silently dropped by a bare
  // top-level throw.
  process.on("unhandledRejection", err => {
    // eslint-disable-next-line no-console
    console.error("[bureau] unhandledRejection:", err)
  })
  process.on("uncaughtException", err => {
    // eslint-disable-next-line no-console
    console.error("[bureau] uncaughtException:", err)
  })

  for (const plugin of extraPlugins) await checkLicense(plugin)
  const plugins = [
    ...extraPlugins,
    ...(await loadPlugins(pluginSpecs(argv))),
  ]
  const { entries, extraRoutes, store, camofox } = buildCatalogue({ plugins })

  const host = resolveHost(argv)
  const port = Number(process.env.PORT ?? process.env.BUREAU_PORT ?? 8830)

  // ── HTTP server ────────────────────────────────────────────────────────────
  const httpServer = createBureauHttpServer({
    entries,
    extraRoutes,
    rateLimitDisabled: boolEnv("BUREAU_RATELIMIT_DISABLED"),
    port,
  })

  // Live watch: WebSocket upgrade on the same port (camofox screenshot-poll).
  // Resolve the owning userId for a tabId by sweeping saved sessions + the
  // anonymous control scope — a control-scope tab 404s under a session userId
  // and vice versa.
  attachWatch(httpServer, {
    resolveOwner: async tabId => {
      const probes = [...(await store.list()).map(d => d.id), CONTROL_USER_ID]
      for (const userId of probes) {
        const open = await camofox.listTabs(userId).catch(() => [])
        if (open.some(t => t.tabId === tabId)) return userId
      }
      return null
    },
    screenshotsFor: userId =>
      createCamofoxRestClient({
        baseUrl: process.env.CAMOFOX_URL,
        userId,
        apiKey: process.env.CAMOFOX_API_KEY,
      }),
  })

  httpServer.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `bureau capability server on ${host}:${port} — ${entries.length} tools${plugins.length ? ` (plugins: ${plugins.map(p => p.name).join(", ")})` : ""} (MCP POST /mcp, health GET /health, watch WS /watch/:tab)`
    )
  })
}
