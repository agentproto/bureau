/**
 * `bureau doctor` — check that this machine can run the selected browser and
 * that Bureau's own stores are safe. Every probe goes through an injected
 * port, so tests use fakes and never touch a real browser, profile or Keychain.
 *
 *   bureau doctor [--browser ID] [--profile NAME] [--keychain] [--json]
 *
 * Exit code 1 when any check fails.
 */

import { execFileSync } from "node:child_process"
import { statSync } from "node:fs"
import { join } from "node:path"
import type { BrowserProvider, BrowserRegistry } from "@agentproto/driver-browser"
import {
  chromeUserDataRoot,
  createConsentLedger,
  localDoctorPort,
  runDoctor,
  type DoctorPort,
} from "@agentproto/browser-profiles"
import { parseArgs, out } from "../lib/args.js"
import { bureauHome, pairingsPathIn } from "../lib/pairing.js"
import {
  DEFAULT_BROWSER_ID,
  DEFAULT_CAMOFOX_ORIGIN,
  checkProvider,
  createBureauBrowserRegistry,
  fetchCamofoxHealth,
  mapBackendHealth,
  requireBrowser,
  type BackendHealthSample,
  type CamofoxHealthFetcher,
  type ProviderCheck,
} from "../lib/browser-registry.js"
import { chooseBrowserId, browserFlagsFrom } from "../lib/browser-launch.js"
import { loadPlugins, pluginSpecs, type BureauPlugin } from "../plugin.js"

const USAGE = `bureau doctor: check the browser, Chrome access and Bureau's stores

  bureau doctor [--browser ID] [--profile NAME] [--keychain] [--json]

  --browser ID     the browser to check (default: $BUREAU_BROWSER or camofox)
  --profile NAME   the Chrome profile to test read access on (default Default)
  --keychain       also probe the macOS Keychain (may show a prompt; off by default)
  --json           print the report as JSON

  Exits 1 when any check fails.`

export type CheckStatus = "ok" | "fail" | "skipped"

export interface DoctorRow {
  id: string
  status: CheckStatus
  detail: string
  fix?: string
}

export interface DoctorOutput {
  ok: boolean
  browser: string
  checks: DoctorRow[]
}

export interface BureauDoctorDeps {
  registry?: BrowserRegistry
  home?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Permission bits of a file, or null when it does not exist. */
  fileMode?: (path: string) => number | null
  camofoxHealth?: CamofoxHealthFetcher
  providerCheck?: (provider: BrowserProvider) => Promise<ProviderCheck>
  chromePort?: DoctorPort
  /** True when the consent ledger's hash chain verifies. */
  verifyLedger?: (path: string) => boolean
  launchdLoaded?: (label: string) => boolean
  plugins?: readonly BureauPlugin[]
  log?: (line: string) => void
}

const defaultFileMode = (path: string): number | null => {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return null
  }
}

const defaultLaunchdLoaded = (label: string): boolean => {
  try {
    execFileSync("launchctl", ["list", label], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const defaultVerifyLedger = (path: string): boolean => {
  try {
    return createConsentLedger({ path }).verifyChain()
  } catch {
    return false
  }
}

const octal = (mode: number): string => mode.toString(8).padStart(3, "0")

/** Run every check and return the report. Exported for tests; the CLI prints it. */
export async function collectDoctor(
  argv: string[],
  deps: BureauDoctorDeps = {}
): Promise<DoctorOutput> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const { flags } = parseArgs(argv)
  const home = deps.home ?? bureauHome(env)
  const plugins = deps.plugins ?? []
  const registry = deps.registry ?? createBureauBrowserRegistry({ plugins })
  const browserId = chooseBrowserId(browserFlagsFrom(flags), env)
  const fileMode = deps.fileMode ?? defaultFileMode
  const checks: DoctorRow[] = []
  const add = (row: DoctorRow): void => void checks.push(row)

  // ── Provider availability ───────────────────────────────────────────────────
  let provider: BrowserProvider | undefined
  try {
    provider = requireBrowser(registry, browserId)
  } catch (e) {
    add({
      id: "provider",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
      fix: "Pick a registered browser with --browser, or load the plugin that registers it (--plugin).",
    })
  }
  if (provider) {
    const active = provider
    const check = await (deps.providerCheck ?? ((p: BrowserProvider) =>
      checkProvider(p, { platform, env, launchdLoaded: deps.launchdLoaded ?? defaultLaunchdLoaded })))(active)
    add({ id: `provider:${active.id}`, status: check.ok ? "ok" : "fail", detail: check.detail, ...(check.fix ? { fix: check.fix } : {}) })
  }

  // ── Camofox reachability and its /health mapping ─────────────────────────────
  const camofoxUrl = env["CAMOFOX_URL"] ?? DEFAULT_CAMOFOX_ORIGIN
  const camofoxActive = provider?.id === DEFAULT_BROWSER_ID
  let sample: BackendHealthSample | null = null
  let sampleError: unknown
  try {
    sample = await (deps.camofoxHealth ?? fetchCamofoxHealth)(camofoxUrl)
  } catch (e) {
    sampleError = e
  }
  const mapped = mapBackendHealth(sample, sampleError)
  if (mapped.ok) {
    add({ id: "camofox", status: "ok", detail: `camofox answers /health at ${camofoxUrl} (HTTP ${sample?.status ?? "?"})` })
  } else if (!camofoxActive) {
    add({ id: "camofox", status: "skipped", detail: `camofox is not healthy at ${camofoxUrl}, and it is not the selected browser` })
  } else {
    add({
      id: "camofox",
      status: "fail",
      detail: `camofox at ${camofoxUrl} is not healthy: ${mapped.reason ?? "no answer"}${sample ? ` (HTTP ${sample.status})` : ""}`,
      fix: sample
        ? 'A crash-looping camofox stays down until "bureau start" resets it; check its logs for the launch error.'
        : 'Start it with "bureau start", or check the launch command (CAMOFOX_SERVE_CMD or the launchd job).',
    })
  }

  // ── Chrome access: Local State, Full Disk Access ─────────────────────────────
  const profile = flags["profile"] && flags["profile"] !== "true" ? flags["profile"] : "Default"
  const port = deps.chromePort ?? localDoctorPort({ chromeRoot: chromeUserDataRoot() })
  const chrome = runDoctor({ port, profile, checkKeychain: flags["keychain"] === "true" })
  for (const c of chrome.checks) {
    const fix = c.fix ? { fix: c.fix } : {}
    if (c.id === "local-state") {
      add({ id: "chrome-local-state", status: c.status, detail: c.detail, ...fix })
    } else if (c.id === "cookies-db") {
      const fda = c.failure === "full-disk-access"
      add({ id: fda ? "full-disk-access" : "chrome-cookies", status: c.status, detail: c.detail, ...fix })
    } else {
      add({ id: "keychain", status: c.status, detail: c.detail, ...fix })
    }
  }

  // ── Bureau's own stores ──────────────────────────────────────────────────────
  const modeCheck = (id: string, label: string, path: string, missing: string): CheckStatus => {
    if (platform === "win32") {
      add({ id, status: "skipped", detail: `${label}: permission bits are not checked on Windows` })
      return "skipped"
    }
    const mode = fileMode(path)
    if (mode === null) {
      add({ id, status: "skipped", detail: missing })
      return "skipped"
    }
    if ((mode & 0o077) !== 0) {
      add({ id, status: "fail", detail: `${label} is mode ${octal(mode)}, readable by other users`, fix: `chmod 600 ${path}` })
      return "fail"
    }
    add({ id, status: "ok", detail: `${label} is mode ${octal(mode)}` })
    return "ok"
  }

  modeCheck("pairing-store", "pairing store", pairingsPathIn(home), "no pairing store yet (no device has paired)")

  const ledgerPath = join(home, "consent-ledger.jsonl")
  const ledgerMode = modeCheck("consent-ledger", "consent ledger", ledgerPath, "no consent ledger yet (no grant has been made)")
  if (ledgerMode !== "skipped") {
    const chainOk = (deps.verifyLedger ?? defaultVerifyLedger)(ledgerPath)
    add({
      id: "consent-ledger-chain",
      status: chainOk ? "ok" : "fail",
      detail: chainOk ? "consent ledger hash chain verifies" : "consent ledger hash chain is broken: a row was edited, removed or reordered",
      ...(chainOk ? {} : { fix: `Do not edit the ledger. Keep a copy of ${ledgerPath} for review, then move it aside so Bureau starts a fresh chain.` }),
    })
  }

  // ── authorize ────────────────────────────────────────────────────────────────
  const suppliers = plugins.filter(p => p.authorize)
  if (suppliers.length > 1) {
    add({
      id: "authorize",
      status: "fail",
      detail: `more than one plugin supplies authorize: ${suppliers.map(p => p.name).join(", ")}`,
      fix: "Load only one plugin that supplies authorize.",
    })
  } else if (suppliers[0]) {
    add({ id: "authorize", status: "ok", detail: `authorize is supplied by plugin ${suppliers[0].name}` })
  } else {
    add({ id: "authorize", status: "ok", detail: "authorize is device pairing (the default); a request needs a paired device" })
  }

  return { ok: checks.every(c => c.status !== "fail"), browser: browserId, checks }
}

export function formatDoctor(report: DoctorOutput): string {
  const tag = { ok: "[ok]  ", fail: "[FAIL]", skipped: "[skip]" } as const
  const lines = [`bureau doctor (browser: ${report.browser})`]
  for (const c of report.checks) {
    lines.push(`  ${tag[c.status]} ${c.id}: ${c.detail}`)
    if (c.status === "fail" && c.fix) lines.push(`         fix: ${c.fix}`)
  }
  lines.push(report.ok ? "all checks passed" : `${report.checks.filter(c => c.status === "fail").length} check(s) failed`)
  return lines.join("\n")
}

export async function runDoctorCommand(
  argv: string[],
  extraPlugins: readonly BureauPlugin[] = [],
  deps: BureauDoctorDeps = {}
): Promise<number> {
  const say = deps.log ?? out
  const { flags } = parseArgs(argv)
  if (flags["help"]) {
    say(USAGE)
    return 0
  }
  const plugins = deps.plugins ?? [...extraPlugins, ...(await loadPlugins(pluginSpecs(argv, {})))]
  const report = await collectDoctor(argv, { ...deps, plugins })
  say(flags["json"] === "true" ? JSON.stringify(report, null, 2) : formatDoctor(report))
  return report.ok ? 0 : 1
}
