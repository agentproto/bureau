/**
 * Bureau CLI dispatch, shared by core's own `bureau` binary and by any
 * composition root that bundles plugins (a plugin package).
 *
 *   bureau [serve]         start the capability server (MCP over HTTP)
 *   bureau start …         orchestrate Camofox + bureau serve in one shot
 *   bureau session …       manage saved browser identities (scan/save/list/show/rm)
 *   bureau pair | devices | install-mcp   AIP-59 pairing (the only auth)
 *   bureau <plugin cmd> …  any subcommand a loaded plugin registers
 *
 * `--plugin <path|pkg>` (repeatable) and `BUREAU_PLUGINS=a,b` load plugins; a
 * plugin that fails to load aborts with a non-zero exit before anything runs.
 * Subcommand modules are imported lazily so a `session` invocation never builds
 * the server's browser-driver composition root, and vice-versa.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  activatePlugins,
  checkLicense,
  loadPlugins,
  pluginSpecs,
  type BureauPlugin,
} from "./plugin.js"

/** Load centralised env vars (`envs/.env.local` at the workspace root) if not
 *  already set, so the daemon picks up ANTHROPIC_API_KEY etc. without the
 *  caller sourcing the file. `metaUrl` is the calling entry's `import.meta.url`
 *  (the root sits six levels above a `<pkg>/dist/<entry>.js`). */
export function loadWorkspaceEnv(metaUrl: string): void {
  try {
    const here = new URL(metaUrl).pathname
    const root = resolve(here, "../../../../../..")
    const content = readFileSync(resolve(root, "envs/.env.local"), "utf-8")
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue
      const m = line.match(
        /^([A-Z_][A-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(.*?))?\s*$/
      )
      if (!m) continue
      const [, key, dq, sq, bare] = m
      if (key && !(key in process.env))
        process.env[key] = dq ?? sq ?? bare ?? ""
    }
  } catch {
    /* no .env.local or unreadable — fine in CI / prod */
  }
}

const CORE_USAGE = `bureau — the browser stack's installable surface

  bureau [serve]         start the capability server (MCP over HTTP)
  bureau start …         orchestrate Camofox + bureau serve in one shot
  bureau session …       manage saved browser identities (scan/save/list/show/rm)
  bureau pair            pair a remote device (QR + URL over the E2E rendezvous)
  bureau devices …       list | revoke <fingerprint|name> paired devices
  bureau install-mcp     pair a local MCP host (Claude Code, Cursor) and write its config
  bureau --version       print the installed Bureau version

  --plugin <path|pkg>    load a plugin (repeatable; or BUREAU_PLUGINS=a,b)`

function printVersion(metaUrl: string): void {
  const here = new URL(metaUrl).pathname
  const pkg = JSON.parse(
    readFileSync(resolve(here, "../../package.json"), "utf-8")
  ) as { version: string }
  // eslint-disable-next-line no-console
  console.log(pkg.version)
}

export interface CliOptions {
  /** Plugins the composition root bundles (in addition to `--plugin`). */
  plugins?: readonly BureauPlugin[]
  /** The entry's `import.meta.url`, used to locate package.json for --version. */
  metaUrl?: string
}

async function dispatch(argv: string[], opts: CliOptions): Promise<void> {
  const [cmd, ...rest] = argv
  const bundled = opts.plugins ?? []

  switch (cmd) {
    case "-v":
    case "--version":
      printVersion(opts.metaUrl ?? import.meta.url)
      return
    case undefined:
    case "serve": {
      const { runServe } = await import("./serve.js")
      await runServe(rest, bundled)
      return
    }
    case "start": {
      const { runStart } = await import("./commands/start.js")
      process.exitCode = await runStart(rest, bundled)
      return
    }
    case "pair": {
      const { runPair } = await import("./commands/pair.js")
      process.exitCode = await runPair(rest)
      return
    }
    case "devices": {
      const { runDevices } = await import("./commands/pair.js")
      process.exitCode = await runDevices(rest)
      return
    }
    case "install-mcp": {
      const { runInstallMcp } = await import("./commands/install-mcp.js")
      process.exitCode = await runInstallMcp(rest)
      return
    }
  }

  for (const plugin of bundled) await checkLicense(plugin)
  const plugins = [...bundled, ...(await loadPlugins(pluginSpecs(rest)))]
  activatePlugins(plugins)
  const commands = Object.assign({}, ...plugins.map(p => p.commands ?? {}))

  if (cmd === "session") {
    const { runSession } = await import("./commands/session.js")
    process.exitCode = await runSession(rest)
    return
  }
  const pluginCommand = commands[cmd] as
    | ((args: string[]) => Promise<number>)
    | undefined
  if (pluginCommand) {
    process.exitCode = await pluginCommand(rest)
    return
  }
  if (cmd === "-h" || cmd === "--help" || cmd === "help") {
    const extra = Object.keys(commands)
      .sort()
      .map(c => `  bureau ${c} …`)
    // eslint-disable-next-line no-console
    console.log([CORE_USAGE, ...(extra.length ? ["", "plugin commands:", ...extra] : [])].join("\n"))
    return
  }
  // eslint-disable-next-line no-console
  console.error(`bureau: unknown command "${cmd}"\n\n${CORE_USAGE}`)
  process.exitCode = 1
}

/** Run the CLI. Never throws: failures print their message and set exit code 1. */
export async function runCli(
  argv: string[],
  opts: CliOptions = {}
): Promise<void> {
  try {
    await dispatch(argv, opts)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}
