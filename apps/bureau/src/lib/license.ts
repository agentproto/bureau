/**
 * Pro license verification, a business hook. The OSS core is never gated by
 * it: only a plugin that declares a `license` check is asked, and a refusal
 * drops that plugin while the core keeps serving.
 *
 * Token format (three base64url segments joined by `.`, like a compact JWS):
 *
 *   header    {"alg":"EdDSA","typ":"bureau-license"}
 *   payload   {"sub": string, "exp": unix seconds, "features": string[], "iat"?: number, "iss"?: string, "tier"?: string}
 *   signature ed25519 over the ASCII bytes "<header>.<payload>"
 *
 * The public key is supplied by the plugin (the vendor's), never by Bureau.
 * Messages name what is wrong but never echo the token or any part of it.
 */

import { createPublicKey, verify, type KeyObject } from "node:crypto"
import type { LicenseCheck, LicenseResult } from "../plugin.js"

export const LICENSE_TOKEN_TYPE = "bureau-license"

export interface LicensePayload {
  sub: string
  exp: number
  features: string[]
  iat?: number
  iss?: string
  tier?: string
}

export type LicenseVerdict =
  | { ok: true; payload: LicensePayload }
  | { ok: false; code: "missing" | "unsigned" | "malformed" | "bad-signature" | "expired" | "feature-missing"; reason: string }

export interface VerifyLicenseOptions {
  publicKey: KeyObject | string
  /** Unix seconds source (default: the wall clock). */
  now?: () => number
  /** Every listed feature must be present in the token. */
  requiredFeatures?: readonly string[]
}

const b64u = (s: string): Buffer => Buffer.from(s, "base64url")

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString("utf8"))
  } catch {
    return undefined
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

export function verifyLicenseToken(token: string | undefined, opts: VerifyLicenseOptions): LicenseVerdict {
  const fail = (code: Extract<LicenseVerdict, { ok: false }>["code"], reason: string): LicenseVerdict => ({ ok: false, code, reason })
  if (token === undefined || token.trim() === "") return fail("missing", "no license token was provided")
  const parts = token.trim().split(".")
  if (parts.length === 2 || (parts.length === 3 && parts[2] === "")) return fail("unsigned", "the license token is unsigned")
  if (parts.length !== 3) return fail("malformed", "the license token is not in the expected format")
  const [h, p, s] = parts as [string, string, string]

  const header = parseJson(b64u(h))
  if (!isRecord(header) || header.alg !== "EdDSA" || header.typ !== LICENSE_TOKEN_TYPE)
    return fail("malformed", "the license token header is not a bureau EdDSA license")

  let ok = false
  try {
    const key = typeof opts.publicKey === "string" ? createPublicKey(opts.publicKey) : opts.publicKey
    ok = verify(null, Buffer.from(`${h}.${p}`, "ascii"), key, b64u(s))
  } catch {
    ok = false
  }
  if (!ok) return fail("bad-signature", "the license signature does not verify (the token was altered or signed by another key)")

  const payload = parseJson(b64u(p))
  if (
    !isRecord(payload) ||
    typeof payload.sub !== "string" ||
    payload.sub === "" ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    !Array.isArray(payload.features) ||
    !payload.features.every(f => typeof f === "string")
  )
    return fail("malformed", "the license payload is missing sub, exp or features")

  const now = (opts.now ?? ((): number => Math.floor(Date.now() / 1000)))()
  if (payload.exp <= now) return fail("expired", `the license expired on ${new Date(payload.exp * 1000).toISOString().slice(0, 10)}`)

  const features = payload.features as string[]
  const lacking = (opts.requiredFeatures ?? []).filter(f => !features.includes(f))
  if (lacking.length > 0) return fail("feature-missing", `the license does not include: ${lacking.join(", ")}`)

  const out: LicensePayload = {
    sub: payload.sub,
    exp: payload.exp,
    features,
    ...(typeof payload.iat === "number" ? { iat: payload.iat } : {}),
    ...(typeof payload.iss === "string" ? { iss: payload.iss } : {}),
    ...(typeof payload.tier === "string" ? { tier: payload.tier } : {}),
  }
  return { ok: true, payload: out }
}

export interface LicenseCheckOptions extends VerifyLicenseOptions {
  /** The token, or a function reading it (env, file, keychain) at load time. */
  token: string | undefined | (() => string | undefined | Promise<string | undefined>)
}

/** Build the `BureauPlugin.license` check for a vendor public key. */
export function createLicenseCheck(opts: LicenseCheckOptions): LicenseCheck {
  return async (): Promise<LicenseResult> => {
    const token = typeof opts.token === "function" ? await opts.token() : opts.token
    const verdict = verifyLicenseToken(token, opts)
    if (!verdict.ok) return { ok: false, reason: verdict.reason }
    return { ok: true, ...(verdict.payload.tier !== undefined ? { tier: verdict.payload.tier } : {}) }
  }
}
