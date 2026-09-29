/**
 * `bureau install-mcp`: give a local MCP host (Claude Code, Cursor) its own
 * paired device. Mints a local device (no QR, no rendezvous), writes the bearer
 * into the host's MCP config and prints the config diff with the bearer redacted.
 * A re-run that finds a still-valid entry changes nothing; otherwise it replaces
 * this command's previous entry and revokes the device that entry held. The
 * bearer goes into the config file (mode 0600) and nowhere else: it is never
 * printed or logged.
 *
 *   bureau install-mcp [--client claude|cursor] [--config <path>] [--url <mcp-url>]
 *                      [--name <server-key>] [--device <device-name>]
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { PairingHostRegistry } from "@agentproto/pairing-host"
import { out, parseArgs } from "../lib/args.js"
import { bureauHome, createOfflineRegistry } from "../lib/pairing.js"

export type McpClient = "claude" | "cursor"

export function defaultConfigPath(client: McpClient, home: string = homedir()): string {
  return client === "claude" ? join(home, ".claude.json") : join(home, ".cursor", "mcp.json")
}

export interface InstallMcpOptions {
  client: McpClient
  /** Host MCP config to edit. Default per client; tests inject a temp path. */
  configPath?: string
  /** Key of the entry under `mcpServers`. Default `bureau`. */
  serverName?: string
  /** URL of the running Bureau `/mcp`. */
  url: string
  /** Device label shown in `bureau devices list`. Default `mcp-<client>`. */
  deviceName?: string
  registry: PairingHostRegistry
}

export interface InstallMcpResult {
  configPath: string
  fingerprint: string
  deviceName: string
  /** True when an entry under the key already existed and was replaced. */
  replaced: boolean
  /** Fingerprint of the device the previous entry held and that was revoked. */
  revokedFingerprint?: string
  /** The whole host config before and after, for the printed diff. Contains the raw bearer: redact before showing. */
  configBefore: Record<string, unknown>
  configAfter: Record<string, unknown>
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

async function readConfig(path: string): Promise<Json> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw e
  }
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${path} is not valid JSON; fix or move it aside, it was left untouched`)
  }
  if (!isObject(parsed)) throw new Error(`${path} is not a JSON object; it was left untouched`)
  return parsed
}

async function writeConfig(path: string, config: Json): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.bureau-tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

/** The device fingerprint inside a previous entry's bearer, if it is one of ours. */
function previousFingerprint(entry: unknown): string | undefined {
  if (!isObject(entry) || !isObject(entry.headers)) return undefined
  const auth = entry.headers.Authorization
  if (typeof auth !== "string") return undefined
  return /^Bearer apd1\.([0-9a-f]+)\./i.exec(auth)?.[1]
}

export async function installMcp(opts: InstallMcpOptions): Promise<InstallMcpResult> {
  const configPath = opts.configPath ?? defaultConfigPath(opts.client)
  const serverName = opts.serverName ?? "bureau"
  const deviceName = opts.deviceName ?? `mcp-${opts.client}`

  const config = await readConfig(configPath)
  const servers = isObject(config.mcpServers) ? { ...config.mcpServers } : {}
  const previous = servers[serverName]
  const previousFp = previousFingerprint(previous)

  const device = await opts.registry.mintLocalDevice({ name: deviceName })
  const authorization = `Bearer ${device.bearer}`
  servers[serverName] =
    opts.client === "claude"
      ? { type: "http", url: opts.url, headers: { Authorization: authorization } }
      : { url: opts.url, headers: { Authorization: authorization } }

  const configAfter = { ...config, mcpServers: servers }
  try {
    await writeConfig(configPath, configAfter)
  } catch (e) {
    await opts.registry.revoke(device.fingerprint).catch(() => false)
    throw e
  }

  let revokedFingerprint: string | undefined
  if (previousFp && previousFp !== device.fingerprint) {
    if (await opts.registry.revoke(previousFp)) revokedFingerprint = previousFp
  }
  return {
    configPath,
    fingerprint: device.fingerprint,
    deviceName: device.name,
    replaced: previous !== undefined,
    configBefore: config,
    configAfter,
    ...(revokedFingerprint ? { revokedFingerprint } : {}),
  }
}

const BEARER_RE = /^Bearer (apd1\.[0-9a-f]+\.\S+)$/i

/** A copy of the config with every device bearer replaced by a short placeholder, safe to print. */
export function redactBearers(value: unknown): unknown {
  if (typeof value === "string") {
    const m = BEARER_RE.exec(value)
    return m ? `Bearer <device bearer ${(/^apd1\.([0-9a-f]+)\./i.exec(m[1] ?? "")?.[1] ?? "").slice(0, 8)}, redacted>` : value
  }
  if (Array.isArray(value)) return value.map(redactBearers)
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactBearers(v)]))
  return value
}

/** A unified-style line diff of two configs (bearers redacted), 2 lines of context. Empty string when equal. */
export function renderConfigDiff(path: string, before: Json, after: Json): string {
  const a = JSON.stringify(redactBearers(before), null, 2).split("\n")
  const b = JSON.stringify(redactBearers(after), null, 2).split("\n")
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const ops: Array<{ tag: " " | "-" | "+"; line: string }> = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ tag: " ", line: a[i++]! }), j++
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) ops.push({ tag: "+", line: b[j++]! })
    else ops.push({ tag: "-", line: a[i++]! })
  }
  if (!ops.some(o => o.tag !== " ")) return ""
  const near = ops.map((_, k) => ops.slice(Math.max(0, k - 2), k + 3).some(o => o.tag !== " "))
  const lines = [`--- ${path}`, `+++ ${path}`]
  let gap = false
  ops.forEach((o, k) => {
    if (!near[k]) gap = true
    else {
      if (gap) lines.push("@@")
      gap = false
      lines.push(`${o.tag} ${o.line}`)
    }
  })
  return lines.join("\n")
}

/** True when the entry already in the host config is this URL with a bearer that still verifies. */
async function entryIsLive(
  configPath: string,
  serverName: string,
  url: string,
  registry: PairingHostRegistry
): Promise<string | undefined> {
  const config = await readConfig(configPath)
  const entry = isObject(config.mcpServers) ? config.mcpServers[serverName] : undefined
  if (!isObject(entry) || entry.url !== url || !isObject(entry.headers)) return undefined
  const auth = entry.headers.Authorization
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return undefined
  const device = await registry.verifyDeviceBearer(auth.slice("Bearer ".length))
  return device?.fingerprint
}

const USAGE = `bureau install-mcp: pair a local MCP host with this Bureau

  bureau install-mcp [--client claude|cursor] [--config <path>] [--url <mcp-url>]
                     [--name <server-key>] [--device <device-name>]

  --client   claude (default, ~/.claude.json) | cursor (~/.cursor/mcp.json)
  --config   MCP config file to edit (default depends on --client)
  --url      Bureau /mcp URL (default http://127.0.0.1:<PORT or 8830>/mcp)
  --name     key under mcpServers (default "bureau")
  --device   label in \`bureau devices list\` (default mcp-<client>)
  --rotate   mint a fresh device even when the entry already holds a valid one

Safe to re-run: when the entry already holds a valid device for this URL, nothing
changes. Otherwise it replaces its own entry, revokes the device it held before and
prints the config diff with the bearer redacted.`

export async function runInstallMcp(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv)
  if (flags.help) {
    out(USAGE)
    return 0
  }
  const client = flags.client ?? "claude"
  if (client !== "claude" && client !== "cursor") {
    process.stderr.write(`bureau install-mcp: unknown --client "${client}" (claude|cursor)\n`)
    return 2
  }
  const port = Number(process.env.PORT ?? process.env.BUREAU_PORT ?? 8830)
  const url = flags.url ?? `http://127.0.0.1:${port}/mcp`
  const registry = createOfflineRegistry(bureauHome())
  const configPath = flags.config ?? defaultConfigPath(client)
  const serverName = flags.name ?? "bureau"
  if (!flags.rotate) {
    const live = await entryIsLive(configPath, serverName, url, registry)
    if (live) {
      out(`"${serverName}" in ${configPath} already holds a valid device (${live.slice(0, 8)}); nothing changed.`)
      return 0
    }
  }
  const result = await installMcp({
    client,
    configPath,
    serverName,
    ...(flags.device ? { deviceName: flags.device } : {}),
    url,
    registry,
  })
  out(
    `${result.replaced ? "Updated" : "Added"} "${flags.name ?? "bureau"}" in ${result.configPath} ` +
      `(device ${result.deviceName}, ${result.fingerprint.slice(0, 8)}).`
  )
  const diff = renderConfigDiff(result.configPath, result.configBefore, result.configAfter)
  if (diff) out(diff)
  if (result.revokedFingerprint)
    out(`Revoked the previous device ${result.revokedFingerprint.slice(0, 8)}.`)
  out("Restart the host so it picks up the new entry.")
  return 0
}
