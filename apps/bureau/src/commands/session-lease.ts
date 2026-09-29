/**
 * `bureau session lease-approve` — the human half of a session lease.
 *
 *   bureau session lease-approve --session ID --device FP --domains a.com,b.com [--ttl 300] [--valid-for 600]
 *
 * It states exactly what will be lent and to which device, waits for a typed
 * "yes" on a terminal, then signs an approval with the local approver key and
 * prints its id. There is no `--yes`: an approval needs a person at a TTY, so a
 * script or an agent cannot mint one by flag. The signed record never holds a
 * cookie value, only session, domains, device, ttl and expiry.
 */

import { createInterface } from "node:readline/promises"
import { join } from "node:path"
import { fileGrantStore, grantServesDevice, hostCoveredBy, isGrantActive } from "@agentproto/browser-profiles"
import { out } from "../lib/args.js"
import { createApproval, loadOrCreateApproverKey } from "../lib/lease-approval.js"
import { bureauHome } from "../lib/pairing.js"
import { MAX_LEASE_TTL_SECONDS } from "../lib/session-lease.js"

export interface LeaseApproveDeps {
  home?: string
  env?: NodeJS.ProcessEnv
  interactive?: boolean
  ask?: (question: string) => Promise<string>
  now?: () => Date
  log?: (line: string) => void
}

const DEFAULT_VALID_FOR_SECONDS = 600
const MAX_VALID_FOR_SECONDS = 3600

const defaultAsk = (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return rl.question(question).finally(() => rl.close())
}

const flag = (flags: Record<string, string>, name: string): string | undefined => {
  const v = flags[name]
  return v !== undefined && v !== "true" ? v : undefined
}

const seconds = (raw: string | undefined, fallback: number, max: number): number | undefined => {
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= max ? n : undefined
}

export async function cmdLeaseApprove(flags: Record<string, string>, deps: LeaseApproveDeps = {}): Promise<number> {
  const say = deps.log ?? out
  const home = deps.home ?? bureauHome(deps.env ?? process.env)
  const now = deps.now ?? ((): Date => new Date())

  const sessionId = flag(flags, "session")
  const device = flag(flags, "device")
  const domains = (flag(flags, "domains") ?? "")
    .split(",")
    .map(d => d.trim().toLowerCase())
    .filter(d => d.length > 0)
  if (!sessionId || !device || domains.length === 0) {
    say("usage: bureau session lease-approve --session ID --device FINGERPRINT --domains a.com,b.com [--ttl 300] [--valid-for 600]")
    return 1
  }
  const ttl = seconds(flag(flags, "ttl"), 300, MAX_LEASE_TTL_SECONDS)
  const validFor = seconds(flag(flags, "valid-for"), DEFAULT_VALID_FOR_SECONDS, MAX_VALID_FOR_SECONDS)
  if (ttl === undefined || validFor === undefined) {
    say(`bureau session lease-approve: --ttl must be 1..${MAX_LEASE_TTL_SECONDS} and --valid-for 1..${MAX_VALID_FOR_SECONDS} (whole seconds)`)
    return 1
  }
  if (flags["yes"] !== undefined) {
    say("bureau session lease-approve: there is no --yes; a lease approval needs a person at a terminal")
    return 1
  }
  if (!(deps.interactive ?? Boolean(process.stdin.isTTY))) {
    say("bureau session lease-approve: needs an interactive terminal (a human decides, never a script or an agent)")
    return 1
  }

  const at = now()
  const active = fileGrantStore(join(home, "grants.json"))
    .list()
    .filter(g => g.sessionId === sessionId && g.domains !== undefined && isGrantActive(g, at) && grantServesDevice(g, device))
  const uncovered = domains.filter(d => !active.some(g => g.domains?.some(gd => hostCoveredBy(d, gd)) === true))
  if (uncovered.length > 0) {
    say(`bureau session lease-approve: no active grant of session ${sessionId} for device ${device} covers ${uncovered.join(", ")}; run \`bureau session import\` first`)
    return 1
  }

  const answer = await (deps.ask ?? defaultAsk)(
    `Lend the session cookies of ${domains.join(", ")} (session ${sessionId}) to device ${device} for up to ${ttl}s? ` +
      `The approval is single use and valid for ${validFor}s. Type "yes" to approve: `
  )
  if (answer.trim().toLowerCase() !== "yes") {
    say("not approved")
    return 1
  }

  const key = loadOrCreateApproverKey(home)
  const { id, payload } = createApproval({
    home,
    key,
    sessionId,
    domains,
    deviceFingerprint: device,
    maxTtlSeconds: ttl,
    validForSeconds: validFor,
    now,
  })
  say(`approved ${id}: ${payload.domains.join(", ")} for device ${device}, up to ${ttl}s, usable once until ${payload.expiresAt}`)
  say(`pass approvalId "${id}" to session_lease`)
  return 0
}
