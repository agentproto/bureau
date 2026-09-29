/**
 * `bureau session import | list | revoke` — a thin CLI over the L5b consent host.
 *
 *   bureau session import --from chrome --domains a.com,b.com [--yes] [--profile P] [--session ID] [--device FP]
 *   bureau session import --from chrome --full-profile --yes [--profile P]
 *   bureau session grants [--all]        (also shown by `bureau session list`)
 *   bureau session revoke <domain|grant-id>
 *
 * The host does the work and the checks (no wildcard domains, no "all", no
 * agent actor, ledger row per grant and revoke). This file parses flags, asks the
 * human on a terminal, and prints. Nothing here reads or prints a cookie value:
 * grants carry counts only.
 */

import { createInterface } from "node:readline/promises"
import { join } from "node:path"
import {
  chromeUserDataRoot,
  createConsentHost,
  createConsentLedger,
  fileGrantStore,
  isGrantActive,
  localChromePort,
  type ConsentHost,
  type ConsentPrompt,
  type ConsentQuestion,
  type Grant,
} from "@agentproto/browser-profiles"
import { out } from "../lib/args.js"
import { bureauHome } from "../lib/pairing.js"
import { sessionStore } from "../lib/sessions.js"

export interface SessionConsentDeps {
  home?: string
  env?: NodeJS.ProcessEnv
  /** Builds the consent host; `prompt` is set only when a human can be asked. */
  createHost?: (prompt: ConsentPrompt | undefined) => ConsentHost
  /** Whether a human can answer prompts (default: stdin is a TTY). */
  interactive?: boolean
  /** Asks one question on the terminal and returns the answer (default: readline). */
  ask?: (question: string) => Promise<string>
  now?: () => Date
  log?: (line: string) => void
}

function defaultAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return rl.question(question).finally(() => rl.close())
}

function terminalPrompt(ask: (q: string) => Promise<string>): ConsentPrompt {
  const yes = async (q: string): Promise<boolean> => /^y(es)?$/i.test((await ask(q)).trim())
  return {
    confirm(question: ConsentQuestion): Promise<boolean> {
      switch (question.kind) {
        case "domain": {
          const seen = question.presentCount === undefined ? "" : ` (${question.presentCount} cookies present)`
          return yes(`Import the cookies of ${question.domain} from Chrome profile "${question.profile}"${seen}? [y/N] `)
        }
        case "full-profile":
          return yes(`${question.warning}\nGrant the FULL profile "${question.profile}"? [y/N] `)
        case "sink":
          return yes(`Send the session ${question.sessionId} to remote provider ${question.providerId}? [y/N] `)
      }
    },
  }
}

function hostFor(deps: SessionConsentDeps, prompt: ConsentPrompt | undefined): ConsentHost {
  if (deps.createHost) return deps.createHost(prompt)
  const home = deps.home ?? bureauHome(deps.env ?? process.env)
  return createConsentHost({
    grants: fileGrantStore(join(home, "grants.json")),
    ledger: createConsentLedger({ path: join(home, "consent-ledger.jsonl") }),
    store: sessionStore(),
    jarDir: join(home, "grant-jars"),
    chrome: localChromePort({ chromeRoot: chromeUserDataRoot() }),
    ...(prompt ? { prompt } : {}),
  })
}

const isInteractive = (deps: SessionConsentDeps): boolean => deps.interactive ?? Boolean(process.stdin.isTTY)
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export async function cmdImport(flags: Record<string, string>, deps: SessionConsentDeps = {}): Promise<number> {
  const say = deps.log ?? out
  const from = flags["from"]
  if (from !== "chrome") {
    say(`bureau session import: --from chrome is required (the only supported source), got ${from === undefined ? "nothing" : `"${from}"`}`)
    return 1
  }
  const prompt = isInteractive(deps) ? terminalPrompt(deps.ask ?? defaultAsk) : undefined
  const host = hostFor(deps, prompt)
  const profile = flags["profile"] && flags["profile"] !== "true" ? flags["profile"] : "Default"
  const sessionId = flags["session"] && flags["session"] !== "true" ? flags["session"] : "imported"
  const deviceId = flags["device"] && flags["device"] !== "true" ? flags["device"] : undefined
  const yes = flags["yes"] === "true"

  try {
    if (flags["full-profile"] === "true") {
      const result = await host.grantFullProfile({ sessionId, profile, yes, ...(deviceId ? { deviceId } : {}) })
      say(result.warning)
      for (const w of result.warnings) say(`warning: ${w}`)
      say(`granted the full profile "${profile}" as ${result.grant.id} (session ${sessionId}, local only)`)
      return 0
    }
    const domains = (flags["domains"] ?? "")
      .split(",")
      .map(d => d.trim())
      .filter(d => d.length > 0)
    const result = await host.importFromChrome({
      sessionId,
      profile,
      domains,
      yes,
      ...(deviceId ? { deviceId } : {}),
    })
    for (const w of result.warnings) say(`warning: ${w}`)
    say(`granted ${result.grant.id}: ${(result.grant.domains ?? []).join(", ")} from Chrome profile "${profile}" (${result.grant.cookieCount} cookies, session ${sessionId})`)
    return 0
  } catch (e) {
    say(`bureau session import: ${message(e)}`)
    return 1
  }
}

const statusOf = (g: Grant, now: Date): string => {
  if (g.revokedAt !== undefined) return "revoked"
  return isGrantActive(g, now) ? "active" : "expired"
}

/** Domains, granted-at and device fingerprint per grant. Never cookie values. */
export function cmdGrants(flags: Record<string, string>, deps: SessionConsentDeps = {}): number {
  const say = deps.log ?? out
  const now = (deps.now ?? ((): Date => new Date()))()
  const all = flags["all"] === "true"
  const grants = hostFor(deps, undefined)
    .listGrants()
    .filter(g => all || isGrantActive(g, now))
  if (grants.length === 0) {
    say(all ? "no consent grants" : "no active consent grants")
    return 0
  }
  say("consent grants:")
  for (const g of grants) {
    const what = g.fullProfile ? `FULL PROFILE "${g.source.profile}"` : (g.domains ?? []).join(",")
    say(
      `  ${g.id}  ${statusOf(g, now).padEnd(7)}  ${what}  granted ${g.grantedAt}  device ${g.deviceId ?? "any paired device"}  session ${g.sessionId}`
    )
  }
  return 0
}

export async function cmdRevoke(arg: string | undefined, deps: SessionConsentDeps = {}): Promise<number> {
  const say = deps.log ?? out
  if (!arg) {
    say("usage: bureau session revoke <domain|grant-id>")
    return 1
  }
  const now = (deps.now ?? ((): Date => new Date()))()
  const host = hostFor(deps, undefined)
  const byId = host.getGrant(arg)
  const wanted = arg.trim().toLowerCase()
  const targets = byId
    ? [byId]
    : host.listGrants().filter(g => isGrantActive(g, now) && (g.domains ?? []).some(d => d.toLowerCase() === wanted))
  if (targets.length === 0) {
    say(`bureau session revoke: no active grant matches "${arg}"`)
    return 1
  }
  let failed = 0
  for (const g of targets) {
    if (g.revokedAt !== undefined) {
      say(`${g.id} is already revoked`)
      continue
    }
    try {
      const { derived } = await host.revoke(g.id)
      say(`revoked ${g.id}: local material ${derived.local}, remote ${derived.remote}`)
    } catch (e) {
      failed += 1
      say(`bureau session revoke: ${g.id}: ${message(e)}`)
    }
  }
  return failed === 0 ? 0 : 1
}
