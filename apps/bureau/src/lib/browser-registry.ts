/**
 * The one place that names a specific browser provider or its client.
 *
 * Server code (serve, start, doctor, the capability gate) resolves a browser
 * through the kit registry built here, by id; it never imports an adapter
 * package. A third-party provider arrives through the plugin seam
 * (`BureauPlugin.browsers`) and is selectable by its id like the built-ins.
 * `no-provider-imports.test.ts` fails when any other file imports an adapter.
 */

import { createBrowserRegistry, type BrowserProvider, type BrowserRegistry } from "@agentproto/driver-browser"
import { camofox, mapCamofoxHealth, createCamofoxRestClient, resolveCamofoxLaunchCommand } from "@agentproto/adapter-browser-camofox"
import { chrome, resolveChrome, CHROME_ENV_VAR } from "@agentproto/adapter-browser-chrome"
import { chromium } from "@agentproto/adapter-browser-chromium"
import { createBrowserDriverRegistry, type BrowserDriverRegistry } from "@agentproto/bureau-drivers"
import {
  createCamofoxRestClient as createBureauCamofoxClient,
  registerCamofoxDriver,
  BLOCKED_PAGE_EXPRESSION,
} from "@agentproto/bureau-drivers/camofox"
import type { BureauPlugin } from "../plugin.js"

export { BLOCKED_PAGE_EXPRESSION }

export const DEFAULT_BROWSER_ID = "camofox"
export const DEFAULT_CAMOFOX_ORIGIN = "http://127.0.0.1:9377"

/** Lower-case a user-supplied browser name; `camoufox` (the upstream spelling) means `camofox`. */
export function normalizeBrowserId(raw: string): string {
  const id = raw.trim().toLowerCase()
  return id === "camoufox" ? "camofox" : id
}

export interface BrowserRegistryOptions {
  /** Plugins whose `browsers` are registered after the built-ins. */
  plugins?: readonly BureauPlugin[]
  /** Replaces the built-in providers (tests inject providers built over fakes). */
  builtins?: readonly BrowserProvider[]
}

/** The built-in local providers: camofox, chrome, chromium. */
export function defaultBuiltinProviders(): BrowserProvider[] {
  return [camofox, chrome, chromium]
}

/** Kit registry with the built-ins plus every plugin's providers. A duplicate id fails loud, naming the plugin. */
export function createBureauBrowserRegistry(opts: BrowserRegistryOptions = {}): BrowserRegistry {
  const registry = createBrowserRegistry(opts.builtins ?? defaultBuiltinProviders())
  for (const plugin of opts.plugins ?? []) {
    for (const provider of plugin.browsers ?? []) {
      try {
        registry.register(provider)
      } catch (e) {
        throw new Error(`plugin "${plugin.name}" cannot register browser "${provider.id}": ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  return registry
}

/** Resolve a (possibly aliased) id to a provider, or throw an error listing the registered ids. */
export function requireBrowser(registry: BrowserRegistry, raw: string): BrowserProvider {
  return registry.require(normalizeBrowserId(raw))
}

export type BureauCamofoxClient = ReturnType<typeof createBureauCamofoxClient>

/** Camofox REST client bound to a user scope, for the tool catalogue and live watch. */
export function createCamofoxClient(userId: string): BureauCamofoxClient {
  return createBureauCamofoxClient({
    baseUrl: process.env.CAMOFOX_URL,
    userId,
    apiKey: process.env.CAMOFOX_API_KEY,
  })
}

/** Driver registry the control tools resolve through (camofox backend). */
export function createControlDriverRegistry(client: BureauCamofoxClient): BrowserDriverRegistry {
  const registry = createBrowserDriverRegistry()
  registerCamofoxDriver(registry, { client })
  return registry
}

export interface BackendHealthSample {
  status: number
  body: Record<string, unknown>
}

/** Fetches a camofox `/health` (status plus body); rejects when nothing answers. */
export type CamofoxHealthFetcher = (baseUrl: string) => Promise<BackendHealthSample>

export const fetchCamofoxHealth: CamofoxHealthFetcher = async baseUrl => {
  const client = createCamofoxRestClient({ baseUrl })
  const res = await client.health({ timeoutMs: 3000 })
  return { status: res.status, body: { ...res.body } }
}

/** Maps a camofox `/health` sample (or its absence) to the kit's health shape. */
export function mapBackendHealth(sample: BackendHealthSample | null, error?: unknown): { ok: boolean; reason?: string } {
  const mapped = mapCamofoxHealth(sample, error)
  return mapped.reason === undefined ? { ok: mapped.ok } : { ok: mapped.ok, reason: mapped.reason }
}

export interface ProviderCheck {
  ok: boolean
  detail: string
  fix?: string
}

export interface ProviderCheckEnv {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** True when a launchd job with this label is loaded (macOS). */
  launchdLoaded: (label: string) => boolean
}

const CAMOFOX_LAUNCHD_LABEL = "sh.bureau.camofox"

/** Is this provider usable on this machine: binary, launchd label or launch command. */
export async function checkProvider(provider: BrowserProvider, env: ProviderCheckEnv): Promise<ProviderCheck> {
  switch (provider.id) {
    case "camofox": {
      const label = env.env["CAMOFOX_LAUNCHD_LABEL"] ?? CAMOFOX_LAUNCHD_LABEL
      const cmd = resolveCamofoxLaunchCommand({
        env: env.env,
        launchdLabel: label,
        platform: env.platform,
      })
      if (!cmd) {
        return {
          ok: false,
          detail: `no way to start camofox on ${env.platform}: no CAMOFOX_SERVE_CMD and no launchd job`,
          fix: 'Set CAMOFOX_SERVE_CMD (for example CAMOFOX_SERVE_CMD="camoufox serve") or pass --camofox-cmd to bureau start.',
        }
      }
      if (cmd.isLaunchctl && !env.launchdLoaded(label)) {
        return {
          ok: false,
          detail: `launchd job ${label} is not loaded`,
          fix: `Load the job (launchctl bootstrap gui/$UID <plist>) or set CAMOFOX_SERVE_CMD to start camofox directly.`,
        }
      }
      return { ok: true, detail: cmd.isLaunchctl ? `launchd job ${label} is loaded` : "CAMOFOX_SERVE_CMD is set" }
    }
    case "chrome": {
      const bin = resolveChrome()
      return bin
        ? { ok: true, detail: `Chrome found at ${bin}` }
        : { ok: false, detail: "no Chrome binary found", fix: `Install Google Chrome or set ${CHROME_ENV_VAR} to the binary.` }
    }
    default: {
      if (!provider.check) return { ok: true, detail: "no availability probe declared" }
      const usable = await provider.check().catch(() => false)
      return usable
        ? { ok: true, detail: "provider reports it is usable" }
        : { ok: false, detail: `provider "${provider.id}" reports it is not usable here`, fix: `Follow the install steps for "${provider.id}" in its README.` }
    }
  }
}
