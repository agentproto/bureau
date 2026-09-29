/**
 * Session lease: lend ONLY the granted domains' session cookies, for one run, to
 * a paired device. A business hook of the OSS core; it exists only where a
 * consent host exists (the pairing flavour), never under a plugin `authorize`.
 *
 * A lease is issued when, and only when, all of these hold:
 *   1. the caller is a paired device (no anonymous lease);
 *   2. it names a human approval id (F4: an agent alone never mints one; the
 *      approval is created by `bureau session lease-approve`, a terminal act
 *      that signs with the local approver key, see lease-approval.ts);
 *   3. every requested domain is covered by an ACTIVE consent grant that serves
 *      this device (the lease can never exceed the grant);
 *   4. the approval verifies (ed25519 signature, not expired, exact device,
 *      session, domains and ttl) and has never been used (single use).
 *
 * Receiver contract (memory only). The cookie values are returned once in the
 * tool result. The receiver MUST keep them in memory only, never write them to
 * disk, a log or a cache, must re-call `session_lease` with `leaseId` before
 * each use, and must drop them on any refusal, on `expiresAt`, or after
 * `session_lease_revoke`. Bureau itself stores no lease payload: a lease record
 * holds ids, domains and times only, and each use re-reads the grant's jar, so
 * revoking the consent grant also ends the lease on its next use.
 *
 * Every issue, use, revoke, expiry and deny is a hash-chained ledger row that
 * carries names and ids, never a cookie value.
 */

import { randomBytes } from "node:crypto"
import { grantServesDevice, hostCoveredBy, isGrantActive, type ConsentHost } from "@agentproto/browser-profiles"
import type { McpContentBlock, McpEntry } from "../mcp-tool.js"
import { currentDevice, type DeviceIdentity } from "./device-context.js"
import { consumeApproval, type ApproverPublic } from "./lease-approval.js"
import type { LeaseDenyCode, LeaseLedger } from "./lease-ledger.js"

export const DEFAULT_LEASE_TTL_SECONDS = 300
export const MAX_LEASE_TTL_SECONDS = 900
const MAX_DOMAINS = 20
const LEASE_PROVIDER_ID = "bureau-lease"
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/
const SAFE_ID = /^[\w.@:+/=-]{1,128}$/

const MESSAGES: Record<LeaseDenyCode, string> = {
  approval_required: "a lease needs a human approval id; run `bureau session lease-approve` in a terminal and pass its id",
  no_device: "a lease is only issued to a paired device",
  no_consent_host: "this Bureau has no consent host, so it cannot lease sessions",
  invalid_request: "the lease request is malformed",
  domain_not_granted: "a requested domain is not covered by an active grant for this device",
  approval_not_found: "the approval does not exist",
  approval_already_consumed: "the approval was already used",
  approval_expired: "the approval has expired",
  approval_not_approved: "the approval is not approved",
  payload_mismatch: "the approval does not cover this session, these domains or this ttl",
  signature_invalid: "the approval signature does not verify",
  not_requester: "the approval was issued to a different device",
  lease_not_found: "no such lease for this device",
  lease_revoked: "the lease was revoked",
  lease_expired: "the lease has expired",
}

/** A refusal. The message is fixed per code; it never echoes request input. */
export class LeaseError extends Error {
  constructor(readonly code: LeaseDenyCode) {
    super(MESSAGES[code])
    this.name = "LeaseError"
  }
}

export interface LeaseRequest {
  sessionId?: unknown
  domains?: unknown
  ttlSeconds?: unknown
  approvalId?: unknown
}

export interface LeaseCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

export interface LeasePayload {
  leaseId: string
  sessionId: string
  domains: string[]
  ttlSeconds: number
  expiresAt: string
  /** The receiver keeps these in memory only. */
  cookies: LeaseCookie[]
  receiver: "memory-only"
}

export interface LeaseServiceOptions {
  /** Bureau state dir (holds `approvals/`). */
  home: string
  consent: Pick<ConsentHost, "listGrants" | "cookieSourceFor">
  ledger: LeaseLedger
  /** The approver PUBLIC key, read at each consume (undefined until a human signs the first approval). */
  approver: () => ApproverPublic | undefined
  now?: () => Date
  newId?: () => string
  maxTtlSeconds?: number
  defaultTtlSeconds?: number
  /** Schedule an expiry ledger row when a lease lapses. Default true; tests that inject a clock turn it off. */
  timers?: boolean
  log?: (line: string) => void
}

interface LeaseRecordInMemory {
  leaseId: string
  sessionId: string
  deviceFingerprint: string
  domains: string[]
  ttlSeconds: number
  expiresAtMs: number
  revoked: boolean
  expiredLogged: boolean
}

export interface LeaseService {
  issue(req: LeaseRequest, device: DeviceIdentity | undefined): LeasePayload
  /** Re-read a live lease. Refused (and ledgered) once revoked, expired or no longer covered by a grant. */
  use(leaseId: unknown, device: DeviceIdentity | undefined): LeasePayload
  revoke(leaseId: unknown, device: DeviceIdentity | undefined): { leaseId: string; revoked: true }
  /** Write an expiry row for every lapsed lease not yet recorded. */
  sweep(): void
  entries(): McpEntry[]
  close(): void
}

const safe = (v: unknown): string | undefined => (typeof v === "string" && SAFE_ID.test(v) ? v : undefined)

export function createLeaseService(opts: LeaseServiceOptions): LeaseService {
  const now = opts.now ?? ((): Date => new Date())
  const newId = opts.newId ?? ((): string => `ls_${randomBytes(12).toString("base64url")}`)
  const maxTtl = opts.maxTtlSeconds ?? MAX_LEASE_TTL_SECONDS
  const defaultTtl = Math.min(opts.defaultTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS, maxTtl)
  const log = opts.log ?? ((): void => {})
  const leases = new Map<string, LeaseRecordInMemory>()
  const timers = new Set<NodeJS.Timeout>()

  const deny = (code: LeaseDenyCode, ctx: { leaseId?: unknown; approvalId?: unknown; sessionId?: unknown; device?: DeviceIdentity; domains?: string[] } = {}): never => {
    const leaseId = safe(ctx.leaseId)
    const approvalId = safe(ctx.approvalId)
    const sessionId = safe(ctx.sessionId)
    const fingerprint = safe(ctx.device?.fingerprint)
    const domains = ctx.domains?.filter(d => DOMAIN.test(d))
    try {
      opts.ledger.append({
        event: "deny",
        code,
        ...(leaseId ? { leaseId } : {}),
        ...(approvalId ? { approvalId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(fingerprint ? { deviceFingerprint: fingerprint } : {}),
        ...(domains && domains.length > 0 ? { domains } : {}),
      })
    } catch {
      log("[lease] could not write a deny row")
    }
    log(`[lease] denied: ${code}`)
    throw new LeaseError(code)
  }

  const expire = (l: LeaseRecordInMemory): void => {
    if (l.expiredLogged || l.revoked) return
    l.expiredLogged = true
    try {
      opts.ledger.append({ event: "expire", leaseId: l.leaseId, sessionId: l.sessionId, deviceFingerprint: l.deviceFingerprint, domains: l.domains })
    } catch {
      log("[lease] could not write an expire row")
    }
  }

  const sweep = (): void => {
    const t = now().getTime()
    for (const l of leases.values()) if (!l.revoked && !l.expiredLogged && l.expiresAtMs <= t) expire(l)
  }

  /** The grant-subset check, shared by issue and by every use. */
  const coveredByGrant = (sessionId: string, domains: readonly string[], deviceId: string): boolean => {
    const at = now()
    const usable = opts.consent
      .listGrants()
      .filter(g => g.sessionId === sessionId && g.domains !== undefined && isGrantActive(g, at) && grantServesDevice(g, deviceId))
    return domains.every(d => usable.some(g => g.domains?.some(gd => hostCoveredBy(d, gd)) === true))
  }

  const cookiesFor = (sessionId: string, domains: readonly string[], deviceId: string): LeaseCookie[] => {
    const source = opts.consent.cookieSourceFor({ deviceId })
    return source({ providerId: LEASE_PROVIDER_ID, profile: sessionId })
      .filter(c => domains.some(d => hostCoveredBy(c.domain, d)))
      .map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? "/",
        ...(c.expires !== undefined ? { expires: c.expires } : {}),
        ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
        ...(c.secure !== undefined ? { secure: c.secure } : {}),
        ...(c.sameSite !== undefined ? { sameSite: c.sameSite } : {}),
      }))
  }

  const payloadOf = (l: LeaseRecordInMemory, cookies: LeaseCookie[]): LeasePayload => ({
    leaseId: l.leaseId,
    sessionId: l.sessionId,
    domains: l.domains,
    ttlSeconds: l.ttlSeconds,
    expiresAt: new Date(l.expiresAtMs).toISOString(),
    cookies,
    receiver: "memory-only",
  })

  const own = (leaseId: unknown, device: DeviceIdentity): LeaseRecordInMemory => {
    const l = typeof leaseId === "string" ? leases.get(leaseId) : undefined
    if (!l || l.deviceFingerprint !== device.fingerprint) return deny("lease_not_found", { leaseId, device })
    return l
  }

  const service: LeaseService = {
    issue(req, device) {
      sweep()
      if (!device) return deny("no_device", { approvalId: req.approvalId, sessionId: req.sessionId })
      const ctxBase = { approvalId: req.approvalId, sessionId: req.sessionId, device }
      if (typeof req.approvalId !== "string" || req.approvalId === "") return deny("approval_required", ctxBase)

      const sessionId = safe(req.sessionId)
      const rawDomains = req.domains
      if (
        !sessionId ||
        !Array.isArray(rawDomains) ||
        rawDomains.length === 0 ||
        rawDomains.length > MAX_DOMAINS ||
        !rawDomains.every((d): d is string => typeof d === "string" && DOMAIN.test(d.toLowerCase()))
      )
        return deny("invalid_request", ctxBase)
      const domains = [...new Set(rawDomains.map(d => d.toLowerCase()))].sort()
      let ttl = defaultTtl
      if (req.ttlSeconds !== undefined) {
        if (typeof req.ttlSeconds !== "number" || !Number.isInteger(req.ttlSeconds) || req.ttlSeconds < 1) return deny("invalid_request", { ...ctxBase, domains })
        ttl = Math.min(req.ttlSeconds, maxTtl)
      }
      const ctx = { ...ctxBase, domains }

      if (!coveredByGrant(sessionId, domains, device.fingerprint)) return deny("domain_not_granted", ctx)

      const at = now()
      const verdict = consumeApproval({
        home: opts.home,
        id: req.approvalId,
        approver: opts.approver(),
        deviceFingerprint: device.fingerprint,
        sessionId,
        domains,
        ttlSeconds: ttl,
        now: at,
        alreadyIssued: id => opts.ledger.read().some(r => r.event === "issue" && r.approvalId === id),
      })
      if (!verdict.ok) return deny(verdict.code, ctx)

      const leaseId = newId()
      const record: LeaseRecordInMemory = {
        leaseId,
        sessionId,
        deviceFingerprint: device.fingerprint,
        domains,
        ttlSeconds: ttl,
        expiresAtMs: at.getTime() + ttl * 1000,
        revoked: false,
        expiredLogged: false,
      }
      const cookies = cookiesFor(sessionId, domains, device.fingerprint)
      // The row is written before any cookie leaves this function: no ledger row, no lease.
      opts.ledger.append({
        event: "issue",
        leaseId,
        approvalId: req.approvalId,
        sessionId,
        deviceFingerprint: device.fingerprint,
        domains,
        ttlSeconds: ttl,
        cookieCount: cookies.length,
      })
      leases.set(leaseId, record)
      if (opts.timers !== false) {
        const timer = setTimeout(() => {
          timers.delete(timer)
          sweep()
        }, ttl * 1000 + 25)
        timer.unref()
        timers.add(timer)
      }
      log(`[lease] issued ${leaseId} for ${domains.join(",")} (${ttl}s)`)
      return payloadOf(record, cookies)
    },

    use(leaseId, device) {
      sweep()
      if (!device) return deny("no_device", { leaseId })
      const l = own(leaseId, device)
      if (l.revoked) return deny("lease_revoked", { leaseId: l.leaseId, sessionId: l.sessionId, device, domains: l.domains })
      if (l.expiresAtMs <= now().getTime()) {
        expire(l)
        return deny("lease_expired", { leaseId: l.leaseId, sessionId: l.sessionId, device, domains: l.domains })
      }
      if (!coveredByGrant(l.sessionId, l.domains, device.fingerprint))
        return deny("domain_not_granted", { leaseId: l.leaseId, sessionId: l.sessionId, device, domains: l.domains })
      const cookies = cookiesFor(l.sessionId, l.domains, device.fingerprint)
      opts.ledger.append({ event: "use", leaseId: l.leaseId, sessionId: l.sessionId, deviceFingerprint: device.fingerprint, domains: l.domains, cookieCount: cookies.length })
      return payloadOf(l, cookies)
    },

    revoke(leaseId, device) {
      sweep()
      if (!device) return deny("no_device", { leaseId })
      const l = own(leaseId, device)
      if (l.expiredLogged) return deny("lease_expired", { leaseId: l.leaseId, sessionId: l.sessionId, device, domains: l.domains })
      if (!l.revoked) {
        l.revoked = true
        opts.ledger.append({ event: "revoke", leaseId: l.leaseId, sessionId: l.sessionId, deviceFingerprint: device.fingerprint, domains: l.domains })
        log(`[lease] revoked ${l.leaseId}`)
      }
      return { leaseId: l.leaseId, revoked: true }
    },

    sweep,

    close() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    },

    entries() {
      const text = (body: unknown, isError?: boolean): { content: McpContentBlock[]; isError?: boolean } => ({
        content: [{ type: "text", text: JSON.stringify(body) }],
        ...(isError ? { isError: true } : {}),
      })
      const run = (fn: () => unknown): { content: McpContentBlock[]; isError?: boolean } => {
        try {
          return text(fn())
        } catch (e) {
          if (e instanceof LeaseError) return text({ error: e.code, message: e.message }, true)
          log("[lease] internal error")
          return text({ error: "lease_failed", message: "the lease could not be processed" }, true)
        }
      }
      const list: McpEntry[] = [
        {
          name: "session_lease",
          description:
            "Lend the granted domains' session cookies to this paired device for one run. Needs `session`, `domains`, and `approvalId` from a human " +
            "(`bureau session lease-approve` in a terminal); the approval is single use. Pass `leaseId` alone to re-read a live lease before each use. " +
            "Keep the cookies in memory only; drop them on any refusal, on expiry or after session_lease_revoke.",
          jsonSchema: {
            type: "object",
            properties: {
              session: { type: "string", description: "The saved session id the grants belong to." },
              domains: { type: "array", items: { type: "string" }, description: "Registrable domains, each covered by an active grant for this device." },
              ttlSeconds: { type: "integer", minimum: 1, maximum: maxTtl, description: `Lease lifetime, default ${defaultTtl}, at most ${maxTtl}.` },
              approvalId: { type: "string", description: "Human approval id from `bureau session lease-approve`." },
              leaseId: { type: "string", description: "Re-read an existing lease instead of issuing one." },
            },
          },
          call: async args =>
            run(() =>
              typeof args.leaseId === "string"
                ? service.use(args.leaseId, currentDevice())
                : service.issue({ sessionId: args.session, domains: args.domains, ttlSeconds: args.ttlSeconds, approvalId: args.approvalId }, currentDevice())
            ),
        },
        {
          name: "session_lease_revoke",
          description: "End a lease held by this device. The next session_lease call with that leaseId is refused. Drop any cookies held in memory.",
          jsonSchema: { type: "object", properties: { leaseId: { type: "string" } }, required: ["leaseId"] },
          call: async args => run(() => service.revoke(args.leaseId, currentDevice())),
        },
      ]
      return list
    },
  }
  return service
}
