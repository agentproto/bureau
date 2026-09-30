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

import { createBrowserMcpCatalogue } from "@agentproto/bureau-mcp"
import type { BrowserCapabilityName, BrowserProvider, BrowserRegistry } from "@agentproto/driver-browser"
import type { BrowserDriverKind } from "@agentproto/bureau-core/driver"
import type { BrowserLaunchOptions as BrowserDriverLaunchOptions } from "@agentproto/driver-browser"
import type { AddressInfo } from "node:net"
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
import { currentDevice, runAsDevice, type DeviceIdentity } from "./lib/device-context.js"
import { createIntrospectionEntries } from "./lib/introspection-tools.js"
import { createSyncEntry } from "./lib/sync-tools.js"
import { keychainCredentialStore } from "./lib/credentials.js"
import { createScrapeEntries } from "./lib/scrape-tools.js"
import { createDownloadEntry } from "./lib/download-tools.js"
import { createWorkflowEntries } from "./lib/workflow-tools.js"
import { createBureauHttpServer, type Authorize } from "./lib/mcp-server.js"
import { bureauHome, createBureauPairing, type BureauPairing } from "./lib/pairing.js"
import { startControlServer, type ControlServer } from "./lib/pairing-control.js"
import { assertDeviceMaySeeSession, gateEntriesByDevice } from "./lib/grant-gate.js"
import { ConsentRequiredError } from "@agentproto/browser-profiles"
import { createLeaseLedger, leaseLedgerPathIn } from "./lib/lease-ledger.js"
import { loadApproverPublic } from "./lib/lease-approval.js"
import { createLeaseService, type LeaseService, type LeaseServiceOptions } from "./lib/session-lease.js"
import { createLiveView, type LiveViewOptions } from "./lib/live-view.js"
import {
  DEFAULT_HEARTBEAT_MS,
  createBrowserUsageTracker,
  createJsonlUsageMeter,
  noopUsageTracker,
  type BrowserUsageTracker,
  type UsageClock,
} from "./lib/usage-meter.js"
import type { HumanSession } from "./lib/ports.js"
import {
  chromeUserDataRoot,
  createConsentHost,
  createConsentLedger,
  fileGrantStore,
  localChromePort,
} from "@agentproto/browser-profiles"
import { join } from "node:path"
import {
  DEFAULT_BROWSER_ID,
  createBureauBrowserRegistry,
  createCamofoxClient,
  createControlDriverRegistry,
  createKitControlProvider,
  requireBrowser,
  type BureauCamofoxClient,
} from "./lib/browser-registry.js"
import { gateEntriesByCapability } from "./lib/capability-gate.js"
import {
  browserFlagsFrom,
  chooseBrowserId,
  planBrowserLaunch,
  type BrowserFlags,
} from "./lib/browser-launch.js"
import {
  createBrowserRuntime,
  unmanagedStatus,
  isFatalLaunchError,
  type BrowserRuntime,
  type BrowserRuntimeOptions,
} from "./lib/browser-runtime.js"
import { removeRunState, writeRunState, type RunState } from "./lib/run-state.js"
import { recipeRegistry } from "./lib/recipe-registry.js"
import { setWorkflowHooks } from "./lib/workflow-hooks.js"
import { registerSampleRecipes } from "./recipes/index.js"
import { attachWatch } from "./lib/watch.js"
import { boolEnv, parseArgs } from "./lib/args.js"
import {
  PluginLicenseError,
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
  camofox: BureauCamofoxClient
  /** Every registered browser: the built-ins plus each plugin's. */
  browsers: BrowserRegistry
  /** The active browser whose capabilities gate the tools. */
  browser: BrowserProvider
  /** Live sessions (the active-driver pool), read by the live view. */
  pool: Map<string, Promise<HumanSession>>
}

export interface CatalogueOptions {
  plugins?: readonly BureauPlugin[]
  usage?: UsageMeter
  /** Kit registry to resolve the browser from (default: built-ins plus the plugins' providers). */
  browsers?: BrowserRegistry
  /** The active browser (default: camofox). Tools it lacks the capability for answer with a typed error. */
  browser?: BrowserProvider
  /** Told when a live session opens and closes (browser-minute metering). */
  sessionUsage?: BrowserUsageTracker
  /** Kit launch options (headless, profile...) for the control-driver attach. */
  launchOptions?: BrowserDriverLaunchOptions
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
  const log = (s: string): void => {
    // eslint-disable-next-line no-console
    console.log(s)
  }
  const browsers = opts.browsers ?? createBureauBrowserRegistry({ plugins })
  const browser = opts.browser ?? requireBrowser(browsers, DEFAULT_BROWSER_ID)
  const camofox = createCamofoxClient(CONTROL_USER_ID)
  const registry = createControlDriverRegistry(camofox)
  // A CDP-capable kit browser (chrome, chromium) is driven directly: the
  // control tools attach to the supervised instance and answer CDP questions
  // with real data, not a camofox error string. Camofox stays the default kind.
  let controlDefaultKind: BrowserDriverKind = "camofox"
  const kitControl = createKitControlProvider({
    provider: browser,
    launchOptions: opts.launchOptions,
    log,
  })
  if (kitControl) {
    registry.register(kitControl)
    controlDefaultKind = browser.id === "chromium" ? "chromium" : "chrome"
  }

  // ── Control catalogue ──────────────────────────────────────────────────────
  // Raw BrowserMcpToolDescriptor[] from the vendor-neutral catalogue; also kept
  // as a Map so scrape can compose navigate/evaluate without going through MCP
  // content blocks.
  const controlCatalogue = createBrowserMcpCatalogue({
    registry,
    defaultKind: controlDefaultKind,
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
  const base = sessionResolver(sessionDeps)
  const { resolvePooledDriver, pooledResolver, pool } = createActiveDriverPool(
    base,
    {
      log,
      ...(opts.sessionUsage
        ? {
            onSessionOpen: (id: string): void => opts.sessionUsage?.sessionStarted(id, currentDevice()?.fingerprint),
            onSessionClose: (id: string): void => opts.sessionUsage?.sessionStopped(id),
          }
        : {}),
    }
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

  const toolCapabilities: Record<string, BrowserCapabilityName> = {}
  for (const plugin of plugins) Object.assign(toolCapabilities, plugin.toolCapabilities)
  const gated = gateEntriesByCapability(entries, { active: browser, registry: browsers, extra: toolCapabilities })

  return { entries: gated, extraRoutes, store, camofox, browsers, browser, pool }
}

/** Parse `--host <h>` (else `$BUREAU_HOST`, else `127.0.0.1`) — the default
 *  loopback bind is F1/Decision 5 (Bureau used to bind all interfaces with no
 *  auth). Exported for the default-bind test. */
export function resolveHost(argv: string[] = []): string {
  const { flags } = parseArgs(argv)
  return flags.host || process.env.BUREAU_HOST || "127.0.0.1"
}


/** Test and embedding seams for {@link runServe}. Every field is optional. */
export interface ServeDeps {
  /** Kit registry (default: built-ins plus the plugins' providers). Tests inject providers built over fakes. */
  registry?: BrowserRegistry
  /** Bureau state dir (default `bureauHome()`). */
  home?: string
  log?: (line: string) => void
  /** Environment for flag defaults (default `process.env`). */
  env?: NodeJS.ProcessEnv
  /** Register SIGINT/SIGTERM and the unhandled-error safety net. Default true; tests turn it off. */
  installProcessHandlers?: boolean
  /** Supervisor tuning (clock, retry delay, crash-loop window, launch budget). */
  runtime?: Pick<BrowserRuntimeOptions, "clock" | "healthIntervalMs" | "crashLoop" | "launchBudgetMs">
  /** Called when the browser launch fails in a way retrying cannot fix. Default: exit code 1. */
  onFatal?: (error: Error) => void
  /** Usage meter (default: a plugin's, else the `--usage-file` JSONL sink, else a noop). */
  usage?: UsageMeter
  /** Clock for browser-minute metering (default: the wall clock and real timers). */
  usageClock?: UsageClock
  /** Session lease tuning (clock, ids, ttl cap, expiry timers). */
  lease?: Pick<LeaseServiceOptions, "now" | "newId" | "maxTtlSeconds" | "defaultTtlSeconds" | "timers">
  /** Live view tuning (frame interval and stream limits). */
  live?: Pick<LiveViewOptions, "intervalMs" | "minIntervalMs" | "maxStreamsPerDevice" | "maxStreamMs">
}

export interface ServeHandle {
  readonly port: number
  readonly host: string
  /** The supervised browser; undefined under `--no-browser`. */
  readonly runtime: BrowserRuntime | undefined
  /** Settles when the first browser launch attempt is over. Never rejects. */
  readonly browserReady: Promise<void>
  /** Stop the browser Bureau started, drop the state file and close the server. */
  close(): Promise<void>
}

/** Boot the capability server: load plugins, build the catalogue, listen for
 *  MCP over HTTP, and supervise the selected browser (`--browser`, default
 *  camofox). `argv` is the bureau-serve-specific arg tail (e.g.
 *  `["--host", "0.0.0.0", "--plugin", "./x.js"]`); `extraPlugins` are
 *  already-constructed plugins a composition root (the studio entrypoint) adds.
 *  Rejects, before any port is opened, when a plugin fails to load or a browser
 *  flag is invalid. The browser launches after the port is open, so `/health`
 *  answers `starting` first. */
export async function runServe(
  argv: string[] = [],
  extraPlugins: readonly BureauPlugin[] = [],
  deps: ServeDeps = {}
): Promise<ServeHandle> {
  const env = deps.env ?? process.env
  if (deps.installProcessHandlers !== false) {
    // The MCP SDK's per-request Server.close() can emit unhandled rejections
    // (e.g. trying to send on a transport that's already closed). Without these
    // handlers Node kills the daemon -> the 502/fetch-failed an operator sees
    // (salvage: refs/salvage/stash/2026-07-07-33, crash safety net). Registered
    // FIRST, before any startup work below, so a throw during catalogue
    // construction is still logged rather than silently dropped.
    process.on("unhandledRejection", err => {
      // eslint-disable-next-line no-console
      console.error("[bureau] unhandledRejection:", err)
    })
    process.on("uncaughtException", err => {
      // eslint-disable-next-line no-console
      console.error("[bureau] uncaughtException:", err)
    })
  }

  const log = deps.log ?? ((line: string): void => {
    // eslint-disable-next-line no-console
    console.log(line)
  })

  // A plugin refused by its license is dropped and the core keeps serving; every
  // other plugin failure still aborts the boot. A plugin with no `license` is never asked.
  const licenseRefusals: Array<{ plugin: string; reason: string }> = []
  const refuse = (e: PluginLicenseError): void => {
    licenseRefusals.push({ plugin: e.spec, reason: e.reason })
    log(`[bureau] ${e.message}. The plugin is not loaded; the core keeps serving.`)
  }
  const licensed: BureauPlugin[] = []
  for (const plugin of extraPlugins) {
    try {
      await checkLicense(plugin)
      licensed.push(plugin)
    } catch (e) {
      if (e instanceof PluginLicenseError) refuse(e)
      else throw e
    }
  }
  const plugins = [...licensed, ...(await loadPlugins(pluginSpecs(argv), { onLicenseRefused: refuse }))]

  const { flags } = parseArgs(argv)
  const managed = flags["no-browser"] !== "true"
  const browserFlags: BrowserFlags = browserFlagsFrom(flags)
  const registry = deps.registry ?? createBureauBrowserRegistry({ plugins })

  // ── Auth ───────────────────────────────────────────────────────────────────
  // Pairing (AIP-59) is the only auth in the OSS flavour. A loaded plugin (the
  // studio flavour) may supply its own `authorize` instead; then no pairing
  // registry runs, no consent host exists and there is no device to key grants on.
  const custom = plugins.filter(p => p.authorize)
  if (custom.length > 1)
    throw new PluginLoadError(
      custom.map(p => p.name).join(", "),
      "more than one plugin supplies `authorize`"
    )
  // The consent host is built after the catalogue (it needs the session store),
  // but `--full-profile` is resolved before it, so the proof looks it up lazily.
  let consent: ReturnType<typeof createConsentHost> | undefined
  const hasConsent = custom[0]?.authorize === undefined
  const plan = planBrowserLaunch({
    registry,
    id: chooseBrowserId(browserFlags, env),
    flags: browserFlags,
    env,
    ...(hasConsent
      ? {
          fullProfileProof: grantId => ({
            grantId,
            isActive: () => {
              try {
                return consent?.fullProfileProof({ grantId }).isActive() ?? false
              } catch {
                return false
              }
            },
          }),
        }
      : {}),
  })
  if (plan.provider.id === DEFAULT_BROWSER_ID && plan.options.baseUrl !== undefined)
    env["CAMOFOX_URL"] = plan.options.baseUrl

  // ── Usage metering ─────────────────────────────────────────────────────────
  // One meter: a plugin's own, else the injected one, else the JSONL file sink
  // (`--usage-file` / BUREAU_USAGE_FILE), else the noop default (emits nothing).
  const meters = plugins.filter(p => p.usage)
  if (meters.length > 1)
    throw new PluginLoadError(meters.map(p => p.name).join(", "), "more than one plugin supplies `usage`")
  const usageFile = flags["usage-file"] && flags["usage-file"] !== "true" ? flags["usage-file"] : env["BUREAU_USAGE_FILE"]
  const meter: UsageMeter = meters[0]?.usage ?? deps.usage ?? (usageFile ? createJsonlUsageMeter({ path: usageFile }) : noopUsageMeter)
  const heartbeatRaw = flags["usage-heartbeat-ms"] ?? env["BUREAU_USAGE_HEARTBEAT_MS"]
  const heartbeatMs = heartbeatRaw === undefined ? DEFAULT_HEARTBEAT_MS : Number(heartbeatRaw)
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1)
    throw new Error("bureau: --usage-heartbeat-ms must be a positive whole number of milliseconds")
  const usageTracker: BrowserUsageTracker =
    meter.browser === undefined
      ? noopUsageTracker
      : createBrowserUsageTracker({ meter, browser: plan.provider.id, heartbeatMs, ...(deps.usageClock ? { clock: deps.usageClock } : {}) })

  const catalogue = buildCatalogue({ plugins, browsers: registry, browser: plan.provider, usage: meter, sessionUsage: usageTracker, launchOptions: plan.options })
  const { extraRoutes, store, camofox } = catalogue

  const host = resolveHost(argv)
  const port = Number(flags["port"] ?? env["PORT"] ?? env["BUREAU_PORT"] ?? 8830)
  const home = deps.home ?? bureauHome(env)

  let pairing: BureauPairing | undefined
  let lease: LeaseService | undefined
  let authorize: Authorize
  let entries = catalogue.entries
  if (custom[0]?.authorize) {
    authorize = custom[0].authorize
  } else {
    pairing = createBureauPairing({ home, port, log: line => log(`[pairing] ${line}`) })
    authorize = pairing.authorize
    consent = createConsentHost({
      grants: fileGrantStore(join(home, "grants.json")),
      ledger: createConsentLedger({ path: join(home, "consent-ledger.jsonl") }),
      store,
      jarDir: join(home, "grant-jars"),
      chrome: localChromePort({ chromeRoot: chromeUserDataRoot() }),
    })
    entries = gateEntriesByDevice(entries, consent)
    // Added after the device gate: the lease tools do their own device, grant
    // and approval checks and must answer with a ledgered deny, not a consent error.
    lease = createLeaseService({
      home,
      consent,
      ledger: createLeaseLedger({ path: leaseLedgerPathIn(home) }),
      approver: () => loadApproverPublic(home),
      log: line => log(line),
      ...deps.lease,
    })
    const taken = new Set(entries.map(e => e.name))
    for (const entry of lease.entries())
      if (taken.has(entry.name)) throw new PluginLoadError(entry.name, `tool "${entry.name}" is reserved for the session lease`)
    entries = [...entries, ...lease.entries()]
    if (browserFlags.fullProfile !== undefined) consent.fullProfileProof({ grantId: browserFlags.fullProfile })
  }

  const startedAt = new Date()
  const runtime = managed
    ? createBrowserRuntime({
        provider: plan.provider,
        launchOptions: plan.options,
        log: line => log(`[browser] ${line}`),
        usage: usageTracker,
        ...deps.runtime,
      })
    : undefined

  // ── Live view ──────────────────────────────────────────────────────────────
  // Read-only screenshots of an already open session, behind the same pairing
  // authorize and the calling device's grants (no device, no consent host: pass).
  const consentHost = consent
  const liveView = createLiveView({
    ...deps.live,
    log: line => log(line),
    mayView: (device: DeviceIdentity | undefined, session: string): boolean => {
      if (!device || !consentHost) return true
      try {
        runAsDevice(device, () => assertDeviceMaySeeSession(consentHost, { session }))
        return true
      } catch (e) {
        if (e instanceof ConsentRequiredError) return false
        throw e
      }
    },
    frames: async session => {
      const open = catalogue.pool.get(session)
      if (!open) return undefined
      const human = await open
      const screenshot = human.screenshot
      if (!screenshot) return undefined
      return async () => {
        const shot = await screenshot.call(human, { format: "jpeg", quality: 60 })
        return { bytes: Buffer.from(shot.imageBase64, "base64"), mime: shot.mimeType }
      }
    },
  })

  // ── HTTP server ────────────────────────────────────────────────────────────
  const httpServer = createBureauHttpServer({
    entries,
    extraRoutes,
    authorize,
    rateLimitDisabled: boolEnv("BUREAU_RATELIMIT_DISABLED"),
    port,
    healthExtras: () => ({
      ...(runtime ? runtime.status() : unmanagedStatus(plan.provider.id, startedAt)),
      ...(licenseRefusals.length > 0 ? { licenseRefusals } : {}),
    }),
    liveView,
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
    screenshotsFor: userId => createCamofoxClient(userId),
  })

  let control: ControlServer | undefined
  let closing: Promise<void> | undefined
  let boundPort = port
  const state = (over: Partial<RunState> = {}): RunState => ({
    version: 1,
    pid: process.pid,
    port: boundPort,
    host,
    browser: plan.provider.id,
    browserOwned: false,
    startedAt: startedAt.toISOString(),
    ...over,
  })
  const shutdown = (opts: { keepState?: boolean } = {}): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      await runtime?.stop().catch(() => {})
      usageTracker.stopAll()
      lease?.close()
      await control?.close().catch(() => {})
      await pairing?.registry.shutdown().catch(() => {})
      // A fatal launch error stays in the state file so `bureau start --detach` can report it.
      if (!opts.keepState) await removeRunState(home).catch(() => {})
      await new Promise<void>(resolve => (httpServer.listening ? httpServer.close(() => resolve()) : resolve()))
    })()
    return closing
  }
  if (deps.installProcessHandlers !== false)
    for (const sig of ["SIGINT", "SIGTERM"] as const)
      process.once(sig, () => void shutdown().finally(() => process.exit(0)))

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject)
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject)
      resolve()
    })
  })
  boundPort = (httpServer.address() as AddressInfo).port

  if (pairing) {
    const active = pairing
    void (async (): Promise<void> => {
      try {
        control = await startControlServer(home, active.registry, log)
      } catch (e) {
        log(`[pairing] no control socket: ${e instanceof Error ? e.message : String(e)}`)
      }
      await active.registry.startAutoconnect().catch(e => {
        log(`[pairing] autoconnect failed: ${e instanceof Error ? e.message : String(e)}`)
      })
    })()
  }
  log(
    `bureau capability server on ${host}:${boundPort} — ${entries.length} tools, browser ${plan.provider.id}${managed ? "" : " (not managed)"}${plugins.length ? ` (plugins: ${plugins.map(p => p.name).join(", ")})` : ""} (MCP POST /mcp, health GET /health, watch WS /watch/:tab)`
  )
  await writeRunState(home, state()).catch(e => log(`[bureau] cannot write run state: ${e instanceof Error ? e.message : String(e)}`))

  const browserReady = (async (): Promise<void> => {
    if (!runtime) return
    try {
      const instance = await runtime.start()
      await writeRunState(
        home,
        state({
          browserOwned: !instance.wasAlreadyRunning,
          browserInstanceId: instance.id,
          ...(instance.pid !== undefined ? { browserPid: instance.pid } : {}),
        })
      ).catch(() => {})
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      if (isFatalLaunchError(e)) {
        log(`[browser] ${error.message}`)
        await writeRunState(home, state({ error: error.message })).catch(() => {})
        await shutdown({ keepState: true })
        if (deps.onFatal) deps.onFatal(error)
        else process.exitCode = 1
        return
      }
      // Not fatal: Bureau keeps answering and /health carries the backend's state.
      log(`[browser] ${error.message}`)
      await writeRunState(home, state({ error: error.message })).catch(() => {})
    }
  })()

  return { port: boundPort, host, runtime, browserReady, close: shutdown }
}
