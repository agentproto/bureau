/**
 * Signed human approvals for a session lease, following the AIP-7
 * `approval-request` + `signature` doctypes (agentgovernance/v1).
 *
 * A human approves at the terminal (`bureau session lease-approve`); the local
 * consent side signs the exact payload with its ed25519 approver key. The
 * server holds only the PUBLIC key: it can verify an approval but never make
 * one, and no tool a model can call creates or decides an approval.
 *
 * Layout, per AIP-7: `<home>/approvals/<id>/{request.json,payload.json,signature.json}`.
 * `payload.json` holds the canonical JSON string itself (no trailing newline), so
 * the SHA-256 of the file equals `payloadHash` and the signature is taken over
 * the file's own bytes.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const APPROVAL_KIND = "session-lease"
export const APPROVAL_CHANNEL = "bureau_cli"
const SCHEMA_TAG = "agentgovernance/v1"

/** Stable AIP-7 consume error codes, plus two Bureau adds for the signature and the device binding. */
export type ApprovalErrorCode =
  | "approval_not_found"
  | "approval_already_consumed"
  | "approval_expired"
  | "approval_not_approved"
  | "payload_mismatch"
  | "signature_invalid"
  | "not_requester"

export interface LeaseApprovalPayload {
  kind: typeof APPROVAL_KIND
  sessionId: string
  /** Sorted, lowercase registrable domains the approval covers. */
  domains: string[]
  /** The paired device that may consume it. */
  deviceFingerprint: string
  /** Longest lease (seconds) this approval allows. */
  maxTtlSeconds: number
  /** The approval cannot be consumed after this ISO time. */
  expiresAt: string
  /** Random per approval, so two approvals of the same scope never share a hash. */
  nonce: string
}

/** Canonical JSON per AIP-7: sorted keys at every depth, no whitespace, `undefined` as null. */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const o = value as Record<string, unknown>
    const keys = Object.keys(o).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex")

const isPosix = process.platform !== "win32"

function writePrivate(path: string, text: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
  if (isPosix) chmodSync(path, 0o600)
}

// ── Approver key ─────────────────────────────────────────────────────────────

export const approverKeyPathIn = (home: string): string => join(home, "approver-key.json")
export const approverPublicPathIn = (home: string): string => join(home, "approver.pub.json")

export interface ApproverKey {
  keyId: string
  privateKey: KeyObject
  publicKey: KeyObject
}

/** The signing half: read by the CLI that a human runs. Created on first use, 0600. */
export function loadOrCreateApproverKey(home: string): ApproverKey {
  const file = approverKeyPathIn(home)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { keyId: string; privateKeyPem: string }
    const privateKey = createPrivateKey(raw.privateKeyPem)
    return { keyId: raw.keyId, privateKey, publicKey: createPublicKey(privateKey) }
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString()
  const keyId = `ak_${sha256Hex(publicKeyPem).slice(0, 16)}`
  writePrivate(
    file,
    JSON.stringify({ version: 1, keyId, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() })
  )
  writePrivate(approverPublicPathIn(home), JSON.stringify({ version: 1, keyId, publicKeyPem }))
  return { keyId, privateKey, publicKey }
}

export interface ApproverPublic {
  keyId: string
  publicKey: KeyObject
}

/** The verifying half, all the server ever reads. Undefined when no approval was ever signed here. */
export function loadApproverPublic(home: string): ApproverPublic | undefined {
  const file = approverPublicPathIn(home)
  if (!existsSync(file)) return undefined
  const raw = JSON.parse(readFileSync(file, "utf8")) as { keyId: string; publicKeyPem: string }
  return { keyId: raw.keyId, publicKey: createPublicKey(raw.publicKeyPem) }
}

// ── Records ──────────────────────────────────────────────────────────────────

interface ApprovalRequestRecord {
  $schema: typeof SCHEMA_TAG
  doctype: "approval-request"
  id: string
  kind: typeof APPROVAL_KIND
  title: string
  payloadHash: string
  status: "pending" | "approved" | "denied" | "expired" | "consumed"
  requestedBy: { operator: true }
  channels: string[]
  requestedAt: string
  expiresAt: string
  decision: { decision: "approved" | "denied"; channel: string; decidedAt: string; signaturePath?: string }
  consumedAt?: string
}

interface SignatureRecord {
  $schema: typeof SCHEMA_TAG
  doctype: "signature"
  artifact: string
  decision: "approve"
  documentHash: string
  signer: { id: string }
  signerKind: "user"
  method: "click_through"
  evidence: { kind: "click_through"; ipAddress: string; userAgent: string; signedUrlToken: string }
  signedAt: string
  signature: { alg: "Ed25519"; value: string; publicKeyRef: string }
}

const dirOf = (home: string, id: string): string => join(home, "approvals", id)

export interface CreateApprovalInput {
  home: string
  key: ApproverKey
  sessionId: string
  domains: readonly string[]
  deviceFingerprint: string
  maxTtlSeconds: number
  /** How long the approval stays consumable, in seconds. */
  validForSeconds: number
  now?: () => Date
  newId?: () => string
}

/** The human act: pin the payload, sign it, persist request, payload and signature. Returns the approval id. */
export function createApproval(input: CreateApprovalInput): { id: string; payload: LeaseApprovalPayload } {
  const now = (input.now ?? ((): Date => new Date()))()
  const id = (input.newId ?? ((): string => `apr_${randomBytes(9).toString("base64url")}`))()
  const payload: LeaseApprovalPayload = {
    kind: APPROVAL_KIND,
    sessionId: input.sessionId,
    domains: [...new Set(input.domains.map(d => d.toLowerCase()))].sort(),
    deviceFingerprint: input.deviceFingerprint,
    maxTtlSeconds: input.maxTtlSeconds,
    expiresAt: new Date(now.getTime() + input.validForSeconds * 1000).toISOString(),
    nonce: randomBytes(16).toString("base64url"),
  }
  const canonical = canonicalJson(payload)
  const payloadHash = sha256Hex(canonical)
  const at = now.toISOString()
  const dir = dirOf(input.home, id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writePrivate(join(dir, "payload.json"), canonical)
  const signature: SignatureRecord = {
    $schema: SCHEMA_TAG,
    doctype: "signature",
    artifact: "payload.json",
    decision: "approve",
    documentHash: payloadHash,
    signer: { id: "user:local-operator" },
    signerKind: "user",
    method: "click_through",
    evidence: { kind: "click_through", ipAddress: "127.0.0.1", userAgent: "bureau-cli", signedUrlToken: randomBytes(16).toString("base64url") },
    signedAt: at,
    signature: {
      alg: "Ed25519",
      value: sign(null, Buffer.from(canonical, "utf8"), input.key.privateKey).toString("base64url"),
      publicKeyRef: input.key.keyId,
    },
  }
  writePrivate(join(dir, "signature.json"), JSON.stringify(signature, null, 2))
  const request: ApprovalRequestRecord = {
    $schema: SCHEMA_TAG,
    doctype: "approval-request",
    id,
    kind: APPROVAL_KIND,
    title: `Lend ${payload.domains.join(", ")} session cookies to device ${payload.deviceFingerprint.slice(0, 12)}`,
    payloadHash,
    status: "approved",
    requestedBy: { operator: true },
    channels: [APPROVAL_CHANNEL],
    requestedAt: at,
    expiresAt: payload.expiresAt,
    decision: { decision: "approved", channel: APPROVAL_CHANNEL, decidedAt: at, signaturePath: "signature.json" },
  }
  writePrivate(join(dir, "request.json"), JSON.stringify(request, null, 2))
  return { id, payload }
}

export type ConsumeResult =
  | { ok: true; payload: LeaseApprovalPayload }
  | { ok: false; code: ApprovalErrorCode }

export interface ConsumeInput {
  home: string
  id: string
  approver: ApproverPublic | undefined
  /** The calling paired device. */
  deviceFingerprint: string
  sessionId: string
  domains: readonly string[]
  ttlSeconds: number
  now: Date
  /** True when the ledger already shows this approval issued a lease (replay defence beyond request.json). */
  alreadyIssued: (approvalId: string) => boolean
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return undefined
  }
}

/**
 * Verify and consume one approval. The check order follows AIP-7: existence,
 * lifecycle state, then the signature and hash, then the caller and the exact
 * payload. On success the request is marked `consumed` before returning, so a
 * second call with the same id is refused (`approval_already_consumed`).
 */
export function consumeApproval(input: ConsumeInput): ConsumeResult {
  const fail = (code: ApprovalErrorCode): ConsumeResult => ({ ok: false, code })
  if (!ID_PATTERN.test(input.id)) return fail("approval_not_found")
  const dir = dirOf(input.home, input.id)
  const request = readJson<ApprovalRequestRecord>(join(dir, "request.json"))
  if (!request || request.doctype !== "approval-request" || request.id !== input.id || request.kind !== APPROVAL_KIND)
    return fail("approval_not_found")

  if (request.status === "consumed" || request.consumedAt !== undefined || input.alreadyIssued(input.id))
    return fail("approval_already_consumed")
  if (request.status !== "approved" || request.decision?.decision !== "approved") return fail("approval_not_approved")

  let canonical: string
  let signature: SignatureRecord | undefined
  try {
    canonical = readFileSync(join(dir, "payload.json"), "utf8")
    signature = readJson<SignatureRecord>(join(dir, "signature.json"))
  } catch {
    return fail("approval_not_found")
  }
  const hash = sha256Hex(canonical)
  if (!signature || signature.documentHash !== request.payloadHash) return fail("signature_invalid")
  if (hash !== request.payloadHash) return fail("payload_mismatch")
  if (!input.approver || signature.signature?.publicKeyRef !== input.approver.keyId) return fail("signature_invalid")
  let valid = false
  try {
    valid = verify(null, Buffer.from(canonical, "utf8"), input.approver.publicKey, Buffer.from(signature.signature.value, "base64url"))
  } catch {
    valid = false
  }
  if (!valid || signature.decision !== "approve" || signature.signerKind !== "user") return fail("signature_invalid")

  const payload = readJson<LeaseApprovalPayload>(join(dir, "payload.json"))
  if (!payload || payload.kind !== APPROVAL_KIND || canonicalJson(payload) !== canonical) return fail("payload_mismatch")
  if (Date.parse(payload.expiresAt) <= input.now.getTime()) return fail("approval_expired")
  if (payload.deviceFingerprint !== input.deviceFingerprint) return fail("not_requester")
  const covered = new Set(payload.domains)
  if (
    payload.sessionId !== input.sessionId ||
    input.domains.length === 0 ||
    !input.domains.every(d => covered.has(d)) ||
    input.ttlSeconds > payload.maxTtlSeconds
  )
    return fail("payload_mismatch")

  const consumed: ApprovalRequestRecord = { ...request, status: "consumed", consumedAt: input.now.toISOString() }
  writePrivate(join(dir, "request.json"), JSON.stringify(consumed, null, 2))
  return { ok: true, payload }
}
