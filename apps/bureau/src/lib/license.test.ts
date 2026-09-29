import { describe, expect, it } from "vitest"
import { createLicenseCheck, verifyLicenseToken } from "./license.js"
import { licenseCanary, newLicenseKeys, signLicense } from "../__tests__/support/license-signer.js"

const keys = newLicenseKeys()
const NOW = 1_800_000_000
const now = (): number => NOW
const payload = { sub: "acme", exp: NOW + 3600, features: ["pro", "audit"], tier: "pro" }

describe("verifyLicenseToken", () => {
  it("accepts a valid token and reads its payload", () => {
    const v = verifyLicenseToken(signLicense(keys, payload), { publicKey: keys.publicKey, now })
    expect(v).toEqual({ ok: true, payload })
  })

  it("accepts the public key as PEM", () => {
    const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
    expect(verifyLicenseToken(signLicense(keys, payload), { publicKey: pem, now }).ok).toBe(true)
  })

  it("refuses an expired token", () => {
    const v = verifyLicenseToken(signLicense(keys, { ...payload, exp: NOW - 1 }), { publicKey: keys.publicKey, now })
    expect(v).toMatchObject({ ok: false, code: "expired" })
  })

  it("refuses a tampered payload", () => {
    const [h, , s] = signLicense(keys, payload).split(".") as [string, string, string]
    const forged = Buffer.from(JSON.stringify({ ...payload, exp: NOW + 10 ** 9 })).toString("base64url")
    expect(verifyLicenseToken(`${h}.${forged}.${s}`, { publicKey: keys.publicKey, now })).toMatchObject({ ok: false, code: "bad-signature" })
  })

  it("refuses a token signed by another key", () => {
    const v = verifyLicenseToken(signLicense(newLicenseKeys(), payload), { publicKey: keys.publicKey, now })
    expect(v).toMatchObject({ ok: false, code: "bad-signature" })
  })

  it("refuses unsigned tokens, including alg none", () => {
    const [h, p] = signLicense(keys, payload).split(".") as [string, string]
    expect(verifyLicenseToken(`${h}.${p}`, { publicKey: keys.publicKey, now })).toMatchObject({ ok: false, code: "unsigned" })
    expect(verifyLicenseToken(`${h}.${p}.`, { publicKey: keys.publicKey, now })).toMatchObject({ ok: false, code: "unsigned" })
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "bureau-license" })).toString("base64url")
    expect(verifyLicenseToken(`${none}.${p}.`, { publicKey: keys.publicKey, now })).toMatchObject({ ok: false, code: "unsigned" })
    expect(verifyLicenseToken(`${none}.${p}.AAAA`, { publicKey: keys.publicKey, now })).toMatchObject({ ok: false, code: "malformed" })
  })

  it("refuses a missing or garbled token", () => {
    expect(verifyLicenseToken(undefined, { publicKey: keys.publicKey })).toMatchObject({ ok: false, code: "missing" })
    expect(verifyLicenseToken("", { publicKey: keys.publicKey })).toMatchObject({ ok: false, code: "missing" })
    expect(verifyLicenseToken("a.b.c.d", { publicKey: keys.publicKey })).toMatchObject({ ok: false, code: "malformed" })
  })

  it("requires the features a plugin asks for", () => {
    const token = signLicense(keys, payload)
    expect(verifyLicenseToken(token, { publicKey: keys.publicKey, now, requiredFeatures: ["pro"] }).ok).toBe(true)
    expect(verifyLicenseToken(token, { publicKey: keys.publicKey, now, requiredFeatures: ["sso"] })).toMatchObject({ ok: false, code: "feature-missing" })
  })

  it("never echoes the token in a refusal", () => {
    const token = licenseCanary(keys, NOW - 5)
    const reasons = [
      verifyLicenseToken(token, { publicKey: keys.publicKey, now }),
      verifyLicenseToken(`${token}x`, { publicKey: keys.publicKey, now }),
      verifyLicenseToken(token.split(".").slice(0, 2).join("."), { publicKey: keys.publicKey, now }),
    ].map(v => (v.ok ? "" : v.reason))
    for (const reason of reasons) {
      expect(reason).not.toContain(token)
      expect(reason).not.toContain(token.split(".")[2] ?? "zz")
      expect(reason).not.toContain(token.split(".")[1] ?? "zz")
    }
  })
})

describe("createLicenseCheck", () => {
  it("reads the token lazily and maps the verdict", async () => {
    const check = createLicenseCheck({ publicKey: keys.publicKey, now, token: async () => signLicense(keys, payload) })
    expect(await check()).toEqual({ ok: true, tier: "pro" })
    const refused = await createLicenseCheck({ publicKey: keys.publicKey, now, token: undefined })()
    expect(refused.ok).toBe(false)
  })
})
