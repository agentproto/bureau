/** Test-only license signer. Lives under __tests__, is not exported and is not part of the published files. */

import { generateKeyPairSync, sign, type KeyObject } from "node:crypto"
import { LICENSE_TOKEN_TYPE, type LicensePayload } from "../../lib/license.js"

export interface LicenseKeys {
  publicKey: KeyObject
  privateKey: KeyObject
}

export const newLicenseKeys = (): LicenseKeys => generateKeyPairSync("ed25519")

const b64u = (v: unknown): string => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url")

export function signLicense(keys: LicenseKeys, payload: LicensePayload, header: Record<string, unknown> = { alg: "EdDSA", typ: LICENSE_TOKEN_TYPE }): string {
  const signingInput = `${b64u(header)}.${b64u(payload)}`
  return `${signingInput}.${sign(null, Buffer.from(signingInput, "ascii"), keys.privateKey).toString("base64url")}`
}

export const licenseCanary = (keys: LicenseKeys, exp: number): string => signLicense(keys, { sub: "canary-license-holder", exp, features: ["pro"], tier: "pro" })
