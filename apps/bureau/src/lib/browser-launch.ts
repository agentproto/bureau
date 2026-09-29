/**
 * Turns `--browser / --headless / --headed / --profile / --full-profile` into a
 * validated provider plus launch options. Shared by `serve` and `start` so the
 * two cannot disagree. Profile safety (F11) is the provider's job: a default
 * Chrome dir or profile name is refused there with `browser:profile-refused`;
 * this module only forwards the request and never invents a path.
 */

import {
  assertCapability,
  type BrowserLaunchOptions,
  type BrowserProvider,
  type BrowserRegistry,
  type FullProfileGrantProof,
} from "@agentproto/driver-browser"
import { DEFAULT_BROWSER_ID, normalizeBrowserId, requireBrowser } from "./browser-registry.js"

/** Launch options Bureau hands to any provider. Chrome-family providers read the extra keys. */
export interface BureauLaunchOptions extends BrowserLaunchOptions {
  launchCmd?: string
  fullProfile?: boolean
  fullProfileGrant?: FullProfileGrantProof
}

/** The raw flag values, all optional. */
export interface BrowserFlags {
  browser?: string
  headless?: boolean
  headed?: boolean
  profile?: string
  fullProfile?: string
  browserPort?: number
  launchCmd?: string
  timeoutMs?: number
}

export class BrowserFlagError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BrowserFlagError"
  }
}

const isTrue = (v: string | undefined): boolean => v === "true" || v === ""
const isSet = (v: string | undefined): boolean => v !== undefined

/** Read the browser flags out of a parsed flag map. */
export function browserFlagsFrom(flags: Record<string, string>): BrowserFlags {
  const out: BrowserFlags = {}
  if (isSet(flags["browser"])) out.browser = flags["browser"]
  if (isTrue(flags["headless"])) out.headless = true
  if (isTrue(flags["headed"])) out.headed = true
  if (isSet(flags["profile"])) out.profile = flags["profile"]
  if (isSet(flags["full-profile"])) out.fullProfile = flags["full-profile"]
  const port = flags["browser-port"] ?? flags["camofox-port"]
  if (port !== undefined) {
    const n = Number(port)
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new BrowserFlagError(`--browser-port must be a port number, got "${port}"`)
    out.browserPort = n
  }
  if (isSet(flags["camofox-cmd"])) out.launchCmd = flags["camofox-cmd"]
  if (isSet(flags["timeout"])) {
    const n = Number(flags["timeout"])
    if (!Number.isFinite(n) || n <= 0) throw new BrowserFlagError(`--timeout must be a positive number of seconds, got "${flags["timeout"]}"`)
    out.timeoutMs = Math.round(n * 1000)
  }
  return out
}

/** The browser id: `--browser`, then `$BUREAU_BROWSER`, then the positional alias, then the default. */
export function chooseBrowserId(flags: BrowserFlags, env: NodeJS.ProcessEnv, positional?: string): string {
  return normalizeBrowserId(flags.browser ?? env["BUREAU_BROWSER"] ?? positional ?? DEFAULT_BROWSER_ID)
}

export interface LaunchPlan {
  provider: BrowserProvider
  options: BureauLaunchOptions
}

export interface PlanInput {
  registry: BrowserRegistry
  id: string
  flags: BrowserFlags
  env?: NodeJS.ProcessEnv
  /** Resolves `--full-profile <grantId>` to a proof; absent means the flag is refused. */
  fullProfileProof?: (grantId: string) => FullProfileGrantProof
}

/** Resolve the provider through the registry and validate the flags against its manifest. */
export function planBrowserLaunch(input: PlanInput): LaunchPlan {
  const { flags } = input
  const provider = requireBrowser(input.registry, input.id)
  if (flags.headless && flags.headed) throw new BrowserFlagError("--headless and --headed are mutually exclusive")

  const ctx = { providerId: provider.id }
  if (flags.headless) assertCapability(provider.capabilities, "headless", { ...ctx, tool: "--headless" })
  if (flags.headed) assertCapability(provider.capabilities, "headed", { ...ctx, tool: "--headed" })
  if (flags.profile !== undefined) assertCapability(provider.capabilities, "persistentProfile", { ...ctx, tool: "--profile" })

  const options: BureauLaunchOptions = {}
  if (flags.headless) options.headless = true
  if (flags.headed) options.headless = false
  if (flags.profile !== undefined) options.profile = flags.profile
  if (flags.browserPort !== undefined) options.port = flags.browserPort
  if (flags.timeoutMs !== undefined) options.timeoutMs = flags.timeoutMs
  if (flags.launchCmd !== undefined) options.launchCmd = flags.launchCmd

  // A camofox server elsewhere (CAMOFOX_URL) is the address the launch checks and reuses.
  const camofoxUrl = input.env?.["CAMOFOX_URL"]
  if (provider.id === DEFAULT_BROWSER_ID && flags.browserPort === undefined && camofoxUrl) options.baseUrl = camofoxUrl

  if (flags.fullProfile !== undefined) {
    if (!input.fullProfileProof) {
      throw new BrowserFlagError("--full-profile needs the consent host, which is off when a plugin supplies its own authorize")
    }
    options.fullProfile = true
    options.fullProfileGrant = input.fullProfileProof(flags.fullProfile)
  }
  return { provider, options }
}
