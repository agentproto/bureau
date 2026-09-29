/**
 * Hash-chained ledger of session-lease events: issue, use, revoke, expire, deny.
 *
 * It mirrors the L5b consent ledger (append-only JSONL, 0600, `prev` = SHA-256
 * of the previous line, `seq` counting from 0) but is a separate file because
 * the consent ledger's record shape is closed to grant events. The record is
 * closed here too: every field is an id, a domain name, a number or a code from
 * a fixed list, so there is no place for a cookie value, a bearer or free text.
 */

import { createHash } from "node:crypto"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"

export const leaseLedgerPathIn = (home: string): string => join(home, "lease-ledger.jsonl")

export const LEASE_EVENTS = ["issue", "use", "revoke", "expire", "deny"] as const
export type LeaseEvent = (typeof LEASE_EVENTS)[number]

/** Why a request was refused. A code, never a message built from input. */
export const LEASE_DENY_CODES = [
  "approval_required",
  "no_device",
  "no_consent_host",
  "invalid_request",
  "domain_not_granted",
  "approval_not_found",
  "approval_already_consumed",
  "approval_expired",
  "approval_not_approved",
  "payload_mismatch",
  "signature_invalid",
  "not_requester",
  "lease_not_found",
  "lease_revoked",
  "lease_expired",
] as const
export type LeaseDenyCode = (typeof LEASE_DENY_CODES)[number]

const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/
const SAFE_ID = /^[\w.@:+/=-]{1,128}$/
const sha256Re = /^[0-9a-f]{64}$/

export const leaseRecordSchema = z
  .object({
    seq: z.number().int().min(0),
    at: z.iso.datetime({ offset: true }),
    event: z.enum(LEASE_EVENTS),
    leaseId: z.string().regex(SAFE_ID).optional(),
    approvalId: z.string().regex(SAFE_ID).optional(),
    sessionId: z.string().regex(SAFE_ID).optional(),
    deviceFingerprint: z.string().regex(SAFE_ID).optional(),
    domains: z.array(z.string().max(253).regex(DOMAIN)).optional(),
    ttlSeconds: z.number().int().min(0).optional(),
    cookieCount: z.number().int().min(0).optional(),
    code: z.enum(LEASE_DENY_CODES).optional(),
    prev: z.string().regex(sha256Re).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const need = (field: keyof typeof r): void => {
      if (r[field] === undefined) ctx.addIssue({ code: "custom", message: `${r.event} needs ${field}`, path: [field] })
    }
    if (r.event === "deny") need("code")
    if (r.event === "issue") {
      need("leaseId")
      need("approvalId")
      need("domains")
      need("ttlSeconds")
      need("cookieCount")
    }
    if (r.event === "use" || r.event === "revoke" || r.event === "expire") need("leaseId")
  })

export type LeaseRecord = z.infer<typeof leaseRecordSchema>
export type LeaseEntry = Omit<LeaseRecord, "seq" | "at" | "prev">

export interface LeaseLedger {
  readonly path: string
  /** Validate, stamp and append one row. A row that fails the schema throws and writes nothing. */
  append(entry: LeaseEntry): LeaseRecord
  read(): LeaseRecord[]
  /** True when `seq` counts up from 0 and every `prev` is the SHA-256 of the line before it. */
  verifyChain(): boolean
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")
const isPosix = process.platform !== "win32"

export function createLeaseLedger(opts: { path: string; now?: () => Date }): LeaseLedger {
  const path = opts.path
  const now = opts.now ?? ((): Date => new Date())
  const lines = (): string[] =>
    existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(line => line.length > 0) : []

  return {
    path,
    append(entry) {
      const existing = lines()
      const last = existing[existing.length - 1]
      const candidate = {
        ...entry,
        seq: existing.length,
        at: now().toISOString(),
        ...(last !== undefined ? { prev: sha256(last) } : {}),
      }
      const parsed = leaseRecordSchema.safeParse(candidate)
      if (!parsed.success) throw new Error(`lease ledger: invalid record (${parsed.error.issues.map(i => i.path.join(".") || "record").join(", ")})`)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      appendFileSync(path, `${JSON.stringify(candidate)}\n`, { mode: 0o600 })
      if (isPosix && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600)
      return parsed.data
    },
    read: () => lines().map(line => leaseRecordSchema.parse(JSON.parse(line))),
    verifyChain() {
      let prevLine: string | undefined
      for (const [i, line] of lines().entries()) {
        let rec: ReturnType<typeof leaseRecordSchema.safeParse>
        try {
          rec = leaseRecordSchema.safeParse(JSON.parse(line))
        } catch {
          return false
        }
        if (!rec.success || rec.data.seq !== i) return false
        if (prevLine !== undefined && rec.data.prev !== sha256(prevLine)) return false
        if (prevLine === undefined && rec.data.prev !== undefined) return false
        prevLine = line
      }
      return true
    },
  }
}
