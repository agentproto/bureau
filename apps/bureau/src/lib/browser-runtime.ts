/**
 * The browser Bureau supervises: a kit supervisor around one provider, plus
 * the status fields `/health` reports. Bureau itself always keeps answering;
 * the backend's state rides in additive fields.
 */

import {
  createBrowserSupervisor,
  type BrowserInstance,
  type BrowserLaunchOptions,
  type BrowserProvider,
  type BrowserSupervisor,
  type SupervisorClock,
  type SupervisorState,
} from "@agentproto/driver-browser"

/** Bureau's view of the supervisor state, as reported by `/health`. */
export type BureauBrowserState = "starting" | "healthy" | "degraded" | "crash-looping" | "stopped"

/** The additive `/health` fields. */
export interface BrowserStatusFields {
  browser: string
  state: BureauBrowserState
  restarts: number
  wasAlreadyRunning: boolean
  /** ISO time the current `state` was entered. */
  since: string
}

export function mapSupervisorState(state: SupervisorState): BureauBrowserState {
  switch (state) {
    case "launching":
      return "starting"
    case "running":
    case "idle":
      return "healthy"
    case "down":
      return "degraded"
    case "crash-looping":
      return "crash-looping"
    case "stopped":
      return "stopped"
  }
}

/** Error codes that a retry cannot fix: a refused profile, a missing capability. */
const FATAL_LAUNCH_CODES: ReadonlySet<string> = new Set(["browser:profile-refused", "browser:unsupported"])

function codeOf(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined
  const code = (e as { code: unknown }).code
  return typeof code === "string" ? code : undefined
}

/** True for a launch failure that will not go away by retrying. */
export function isFatalLaunchError(e: unknown): boolean {
  const code = codeOf(e)
  return code !== undefined && FATAL_LAUNCH_CODES.has(code)
}

export interface BrowserRuntimeOptions {
  provider: BrowserProvider
  launchOptions?: BrowserLaunchOptions
  clock?: SupervisorClock
  healthIntervalMs?: number
  crashLoop?: { maxFailures?: number; windowMs?: number; retryDelayMs?: number }
  launchBudgetMs?: number
  now?: () => Date
  log?: (line: string) => void
}

export interface BrowserRuntime {
  readonly browser: string
  /** Launch (idempotent) and supervise. Rejects with the original error for a fatal launch failure. */
  start(): Promise<BrowserInstance>
  /** Clear a crash loop and relaunch. This is what a manual `bureau start` does. */
  restart(): Promise<BrowserInstance>
  stop(): Promise<void>
  status(): BrowserStatusFields
  instance(): BrowserInstance | null
  /** The last launch failure (message only), if any. */
  lastError(): string | undefined
}

export function createBrowserRuntime(opts: BrowserRuntimeOptions): BrowserRuntime {
  const now = opts.now ?? ((): Date => new Date())
  const log = opts.log ?? (() => {})
  let launches = 0
  let backendRestarts = 0
  let since = now().toISOString()
  let fatal: unknown
  let lastError: string | undefined
  let wasAlreadyRunning = false
  let started = false

  // A fatal failure is remembered and replayed on retry, so the supervisor does not
  // relaunch a browser that will refuse for the same reason every time.
  const guarded: BrowserProvider = {
    ...opts.provider,
    launch: async (launchOpts, ctx) => {
      if (fatal !== undefined) throw fatal
      launches += 1
      try {
        const instance = await opts.provider.launch(launchOpts, ctx)
        wasAlreadyRunning = instance.wasAlreadyRunning
        lastError = undefined
        return instance
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        if (isFatalLaunchError(e)) fatal = e
        throw e
      }
    },
  }

  const supervisor: BrowserSupervisor = createBrowserSupervisor({
    provider: guarded,
    ...(opts.launchOptions ? { launchOptions: opts.launchOptions } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.healthIntervalMs !== undefined ? { healthIntervalMs: opts.healthIntervalMs } : {}),
    ...(opts.launchBudgetMs !== undefined ? { launchBudgetMs: opts.launchBudgetMs } : {}),
    ...(opts.crashLoop ? { crashLoop: opts.crashLoop } : {}),
    log,
    onStateChange: () => {
      since = now().toISOString()
    },
    onBackendRestart: () => {
      backendRestarts += 1
    },
  })

  const surface = async (run: () => Promise<BrowserInstance>): Promise<BrowserInstance> => {
    try {
      return await run()
    } catch (e) {
      if (fatal !== undefined) {
        await supervisor.stop().catch(() => {})
        throw fatal
      }
      throw e
    }
  }

  return {
    browser: opts.provider.id,
    start: () => {
      started = true
      return surface(() => supervisor.start())
    },
    restart: () => {
      started = true
      fatal = undefined
      return surface(() => supervisor.restart())
    },
    stop: () => supervisor.stop(),
    instance: () => supervisor.status().instance,
    lastError: () => lastError,
    status() {
      const s = supervisor.status()
      return {
        browser: opts.provider.id,
        state: started ? mapSupervisorState(s.state) : "starting",
        restarts: Math.max(0, launches - 1) + backendRestarts,
        wasAlreadyRunning: s.instance?.wasAlreadyRunning ?? wasAlreadyRunning,
        since,
      }
    },
  }
}

/** Status for a Bureau that supervises no browser (`--no-browser`): nothing is managed. */
export function unmanagedStatus(browser: string, startedAt: Date = new Date()): BrowserStatusFields {
  return { browser, state: "stopped", restarts: 0, wasAlreadyRunning: false, since: startedAt.toISOString() }
}
