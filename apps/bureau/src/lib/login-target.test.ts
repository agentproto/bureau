/**
 * `resolveLoginTarget` / `isSiteLoginWallUrl` — the `session login --url` path
 * that opens any site, not just the known social platforms.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { clearPlatformKit, registerPlatformKit } from "./platform-kit.js"
import { isSiteLoginWallUrl, resolveLoginTarget } from "./session-persist.js"

describe("resolveLoginTarget", () => {
  beforeAll(() =>
    registerPlatformKit({
      platforms: { linkedin: { domain: "linkedin.com" } },
      loginSpec: p =>
        p === "linkedin" ? { url: "https://www.linkedin.com/login" } : undefined,
    })
  )
  afterAll(() => clearPlatformKit())

  it("keeps a known platform on its own login url", () => {
    const t = resolveLoginTarget({ platform: "linkedin" })
    expect(t.ok && t.arbitrary).toBe(false)
    expect(t.ok && t.url).toMatch(/linkedin\.com/)
  })

  it("opens an arbitrary site from --url, platform from the hostname", () => {
    expect(resolveLoginTarget({ url: "https://www.ovh.com/manager/" })).toEqual(
      {
        ok: true,
        platform: "ovh.com",
        url: "https://www.ovh.com/manager/",
        arbitrary: true,
      }
    )
  })

  it("lets --platform name an arbitrary --url site", () => {
    const t = resolveLoginTarget({
      platform: "ovh",
      url: "https://www.ovh.com/manager/",
    })
    expect(t).toMatchObject({ ok: true, platform: "ovh", arbitrary: true })
  })

  it("refuses an unknown platform without --url, a bad url, a non-http url", () => {
    expect(resolveLoginTarget({ platform: "ovh" }).ok).toBe(false)
    expect(resolveLoginTarget({}).ok).toBe(false)
    expect(resolveLoginTarget({ url: "not a url" }).ok).toBe(false)
    expect(resolveLoginTarget({ url: "file:///etc/passwd" }).ok).toBe(false)
  })
})

describe("isSiteLoginWallUrl", () => {
  it("flags portal auth pages", () => {
    expect(
      isSiteLoginWallUrl(
        "https://www.ovh.com/auth/?onsuccess=https%3A%2F%2Fwww.ovh.com%2Fmanager%2F"
      )
    ).toBe(true)
    expect(isSiteLoginWallUrl("https://example.com/signin")).toBe(true)
    expect(isSiteLoginWallUrl("https://example.com/login?next=/")).toBe(true)
  })

  it("passes an authed page", () => {
    expect(
      isSiteLoginWallUrl("https://www.ovh.com/manager/#/hub/billing")
    ).toBe(false)
    expect(isSiteLoginWallUrl("https://example.com/author/jane")).toBe(false)
  })
})
