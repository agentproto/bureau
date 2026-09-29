/**
 * Owned-session persistence helpers shared by the `session` CLI, the
 * `session_sync_from_chrome` tool and any plugin that re-authenticates a
 * session: the descriptor builder for an owned login, login-target resolution,
 * and the force-flush of a live camofox jar to disk.
 */

import {
  buildOwnedSessionDescriptor,
  type SessionDescriptor,
  type SessionStorePort,
} from "@agentproto/browser-profiles"
import { isLoginWallUrl } from "@agentproto/bureau-core/page-eval"
import { knownPlatform, loginSpecFor } from "./platform-kit.js"

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))


/**
 * The `camofox-native` descriptor for an owned login — the SAME shape `cmdLogin`
 * writes. Thin host wrapper over the pure {@link buildOwnedSessionDescriptor}:
 * supplies the wall-clock `now` and the platform's authed-home `url` (a
 * non-redirecting host so a cold reuse tab doesn't open on an unrelated site and
 * trip its anti-bot).
 *
 * `account` (the platform login the credential signed in as) is persisted on
 * `identity` so the `(platform, account)` join in `introspection-tools` populates
 * `hasCredential` / `linkedSessions`. AUGMENTS, not replaces (P3): when `prev`
 * held a chrome link, its provenance survives — see the pure builder's docs.
 */
export function buildOwnedDescriptor(
  id: string,
  platform: string,
  reuseBase: string,
  account?: string,
  prev?: SessionDescriptor,
  siteHome?: string
): SessionDescriptor {
  const home = knownPlatform(platform)
  const url = home ? (home.home ?? `https://${home.domain}/`) : siteHome
  return buildOwnedSessionDescriptor({
    id,
    platform,
    reuseBase,
    ...(account ? { account } : {}),
    ...(prev ? { prev } : {}),
    now: new Date().toISOString(),
    ...(url ? { url } : {}),
  })
}

/** Where `cmdLogin` opens, and the platform key it records. */
export type LoginTarget =
  | { ok: true; platform: string; url: string; arbitrary: boolean }
  | { ok: false }

/**
 * Resolve `--platform` / `--url` into a login target. A known platform keeps
 * its login spec; `--url` opens any site (a billing portal, a SaaS console)
 * with the platform defaulting to the hostname minus `www.`.
 */
export function resolveLoginTarget(flags: {
  platform?: string
  url?: string
}): LoginTarget {
  let siteUrl: URL | undefined
  if (flags.url) {
    try {
      siteUrl = new URL(flags.url)
    } catch {
      return { ok: false }
    }
    if (siteUrl.protocol !== "https:" && siteUrl.protocol !== "http:")
      return { ok: false }
  }
  const platform =
    flags.platform ?? siteUrl?.hostname.replace(/^www\./, "") ?? undefined
  if (!platform) return { ok: false }
  const spec = loginSpecFor(platform)
  const social = knownPlatform(platform)
  if (siteUrl)
    return {
      ok: true,
      platform,
      url: siteUrl.href,
      arbitrary: !spec && !social,
    }
  if (spec) return { ok: true, platform, url: spec.url, arbitrary: false }
  if (social)
    return {
      ok: true,
      platform,
      url: `https://${social.domain}/`,
      arbitrary: false,
    }
  return { ok: false }
}

/**
 * Login-wall check for an arbitrary site: the social wall paths plus the
 * generic `/auth`, `/signin`, `/sign-in`, `/sso` paths most portals redirect to
 * (OVHcloud's manager bounces to `/auth/`).
 */
export function isSiteLoginWallUrl(url: string): boolean {
  return (
    isLoginWallUrl(url) || /\/(auth|signin|sign-in|sso)(\/|\?|#|$)/i.test(url)
  )
}

/**
 * Force-flush the authed jar to disk against the instance that holds the live
 * context, so a restart inside camofox's ≤20s timer window can't lose the login.
 * Loopback-gated server-side; best-effort — returns the cookie count it persisted
 * (or undefined on an older camofox without `/persist`).
 */
export async function persistSessionCookies(
  base: string,
  id: string
): Promise<number | undefined> {
  try {
    const res = await fetch(
      `${base.replace(/\/$/, "")}/sessions/${id}/persist`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
      }
    )
    if (res.ok) {
      const r = (await res.json().catch(() => ({}))) as { cookieCount?: number }
      return r.cookieCount
    }
  } catch {
    /* older camofox without /persist — the timer flush still covers it */
  }
  return undefined
}

/**
 * Force-flush a live context to disk and SURFACE a real failure, instead of the
 * best-effort swallow {@link persistSessionCookies} does for every other caller
 * (where a miss is fine — the ≤20s timer flush still covers it eventually). The
 * adopt flow needs a louder signal here: a genuinely unreachable/erroring camofox
 * mid-adoption means the just-written storageState may not reflect what the live
 * context actually holds. Adoption is a one-shot durable migration with no later
 * timer-flush to fall back on, so — UNLIKE the best-effort helper — a 404 (no
 * `/persist` route on this camofox) is ALSO surfaced as an actionable error: a
 * fresh snapshot is required here, not optional.
 */
export async function forcePersistOrThrow(
  base: string,
  id: string,
  label: string
): Promise<number | undefined> {
  const url = `${base.replace(/\/$/, "")}/sessions/${id}/persist`
  let res: Response
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
    })
  } catch (e) {
    throw new Error(
      `couldn't force-persist the ${label} context "${id}" at ${url}: ${msg(e)}`
    )
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `force-persist of the ${label} context "${id}" failed: camofox at ${base} ` +
          `has no /persist route. Adoption needs a FRESH snapshot for durable ` +
          `migration — unlike a best-effort re-auth flush, there's no later ` +
          `timer-flush to fall back on. Upgrade camofox and retry.`
      )
    }
    const body = await res.text().catch(() => "")
    throw new Error(
      `force-persist of the ${label} context "${id}" failed: ${res.status} ${body.slice(0, 160)}`
    )
  }
  const r = (await res.json().catch(() => ({}))) as { cookieCount?: number }
  return r.cookieCount
}

/**
 * Refresh-after-use (P4, BOUNDED): force-flush the live authed jar to the owned
 * session's storageState via `/persist` AND stamp `lastCookieRefreshAt` on the
 * descriptor, so a working B session's freshness is both durable and *visible*
 * ({@link cookieFreshness}) without a re-login. Best-effort: a `/persist` miss
 * (older camofox, or no live session — the chrome-cookie path decrypts locally so
 * there's nothing to persist) still stamps the descriptor. Returns the persisted
 * cookie count when camofox reported one.
 *
 * Deliberately wired ONLY into the success paths of `session_reauth`/login and
 * `session_sync_from_chrome` — NOT every browser action. Broader auto-flush
 * after any successful run is a follow-up (§8.2 of the audit).
 */
export async function flushCookieRefresh(
  store: SessionStorePort,
  base: string,
  id: string
): Promise<number | undefined> {
  const cookieCount = await persistSessionCookies(base, id)
  const desc = (await store.load(id).catch(() => null)) ?? undefined
  if (desc) {
    await store
      .save({ ...desc, lastCookieRefreshAt: new Date().toISOString() })
      .catch(() => undefined)
  }
  return cookieCount
}
