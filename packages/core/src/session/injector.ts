/**
 * Generic browser-session injector.
 *
 * Replaces the old Camofox-specific HTTP helper. Works against any
 * `IBrowserProvider` implementation that supports the optional `setCookies`
 * method (Camofox, self-hosted — Stagehand and Browserbase may add later).
 *
 * Structural typing on purpose: we don't import `IBrowserProvider` from
 * the integration package to avoid a mutual dep cycle. Any provider
 * that matches the `CookieInjectorCapable` shape is assignable.
 */

import type { BrowserSessionPayload, CookieJson } from "./types.js"

export interface CookieInjectorCapable {
  readonly name: string
  setCookies?(
    sessionId: string,
    cookies: CookieJson[]
  ): Promise<{ ok: boolean; injected: number }>
  /**
   * Set localStorage items on the CURRENT page's origin. The browser must
   * already be navigated to the target URL — localStorage is origin-scoped,
   * so calling this from `example.com` would write to `example.com`, not the
   * intended site.
   *
   * Returns a list of keys that were skipped (e.g. because a single item
   * exceeded the transport body size limit). Callers can surface these in
   * recording metadata or the UI so users know their session is incomplete.
   */
  setStorage?(
    sessionId: string,
    items: Array<{ key: string; value: string }>,
    type?: "local" | "session"
  ): Promise<{ skippedKeys: string[] } | void>
  /** Reload the current page so the app re-reads cookies + localStorage. */
  navigate?(
    sessionId: string,
    url: string,
    options?: { waitUntil?: string; timeout?: number }
  ): Promise<void>
}

export interface InjectSessionResult {
  ok: boolean
  injected: number
}

/**
 * Inject a decrypted session's cookies into an active browser session.
 *
 * Throws if the provider doesn't implement `setCookies` — callers should
 * guard with `typeof provider.setCookies === "function"` when they want to
 * skip injection silently on unsupported providers.
 *
 * Cookie values are percent-encoded before injection. RFC 6265 forbids
 * non-US-ASCII in cookie values; Firefox/Chrome store them in-memory anyway
 * but HTTP headers (via fetch/undici) reject them because WHATWG headers are
 * ByteString. Without this pre-encoding, a single em-dash (char 8212) from a
 * server-set cookie would throw "Cannot convert argument to a ByteString"
 * mid-injection and drop the whole session silently.
 */
export async function injectSession(
  browserProvider: CookieInjectorCapable,
  sessionId: string,
  payload: BrowserSessionPayload
): Promise<InjectSessionResult> {
  if (typeof browserProvider.setCookies !== "function") {
    throw new Error(
      `Browser provider "${browserProvider.name}" does not support setCookies: cannot inject session.`
    )
  }
  const sanitized = payload.cookies.map(sanitizeCookieForHeader)

  // Diagnostic (opt-in via BROWSER_INJECTOR_DEBUG): scan every field of every
  // sanitized cookie for chars > 0x7E. If a ByteString error persists after
  // `value` sanitization, one of the other fields (name/domain/path/sameSite)
  // is the culprit — log which one to narrow the fix instead of guessing.
  // Off by default: this is a per-cookie O(n·len) scan in a shared lib that
  // runs on every injection.
  if (process.env.BROWSER_INJECTOR_DEBUG) {
    // On pathological payloads with thousands of cookies, log only the first
    // few offenders to avoid flooding the logs — then summarize the rest as a
    // single line. The loop keeps running so the total count stays accurate.
    const MAX_OFFENDER_LOGS = 20
    let offenderLogCount = 0
    let offenderTotal = 0
    for (let i = 0; i < sanitized.length; i++) {
      const c = sanitized[i]!
      for (const field of [
        "name",
        "value",
        "domain",
        "path",
        "sameSite",
      ] as const) {
        const v = c[field]
        if (typeof v !== "string") continue
        for (let j = 0; j < v.length; j++) {
          const code = v.charCodeAt(j)
          if (code > 0x7e) {
            offenderTotal++
            if (offenderLogCount < MAX_OFFENDER_LOGS) {
              console.warn(
                `[injector] cookie[${i}].${field} has char ${code} at index ${j} (cookie name="${c.name}", len=${v.length}, snippet="${v.slice(Math.max(0, j - 10), j + 10)}")`
              )
              offenderLogCount++
            }
          }
        }
      }
    }
    if (offenderTotal > MAX_OFFENDER_LOGS) {
      console.warn(
        `[injector] ... and ${offenderTotal - MAX_OFFENDER_LOGS} more non-ASCII fields`
      )
    }
  }

  try {
    return await browserProvider.setCookies(sessionId, sanitized)
  } catch (err) {
    // Capture the full chain so we can find out where the ByteString conversion
    // actually throws — the stack tells us whether it's URL, headers, method,
    // or body. Re-throw so the caller's catch still runs.
    if (err instanceof Error) {
      const cause = (err as { cause?: unknown }).cause
      const causeStr =
        cause instanceof Error ? `${cause.name}: ${cause.message}` : ""
      console.warn(
        `[injector] setCookies threw: ${err.name}: ${err.message}${causeStr ? ` | cause=${causeStr}` : ""}`
      )
      console.warn(`[injector] stack:`, err.stack)
      if (cause instanceof Error) {
        console.warn(`[injector] cause stack:`, cause.stack)
      }
    }
    throw err
  }
}

/**
 * Return a cookie whose `name`/`value` are guaranteed to round-trip through
 * any WHATWG-compliant HTTP stack (undici, Chrome devtools protocol, etc.).
 *
 * - Values: percent-encode any char outside 0x20-0x7E. Servers decode this
 *   transparently; tokens, session IDs, and base64 are untouched.
 * - Names: if a name has a non-ASCII char, there's no safe encoding — drop
 *   the cookie. Non-ASCII cookie names don't occur in practice.
 */
function sanitizeCookieForHeader(cookie: CookieJson): CookieJson {
  return {
    ...cookie,
    value: encodeCookieValue(cookie.value),
  }
}

function encodeCookieValue(value: string): string {
  let needsEncode = false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) {
      needsEncode = true
      break
    }
  }
  if (!needsEncode) return value
  // encodeURIComponent is safe: it percent-encodes all non-ASCII + control
  // characters. Cookie semicolons/commas/spaces also get encoded, which is
  // fine — servers URL-decode on read.
  return encodeURIComponent(value)
}

/**
 * Find localStorage items in the payload that belong to the origin of
 * `currentUrl`. The extension stores localStorage as a per-origin map:
 *
 *   { "https://www.tiktok.com": { webId: "...", tt_chain_token: "..." } }
 *
 * We match by hostname (case-insensitive, www-stripped) so that capturing on
 * `www.tiktok.com` and navigating to `tiktok.com` (or vice versa) still
 * resolves. Returns a flat `[{key, value}]` list ready for `setStorage`.
 */
export function selectLocalStorageForUrl(
  payload: BrowserSessionPayload,
  currentUrl: string
): Array<{ key: string; value: string }> {
  if (!payload.localStorage) return []
  let target: string
  try {
    target = new URL(currentUrl).hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return []
  }

  const items: Array<{ key: string; value: string }> = []
  for (const [origin, kv] of Object.entries(payload.localStorage)) {
    let originHost: string
    try {
      originHost = new URL(origin).hostname.replace(/^www\./, "").toLowerCase()
    } catch {
      continue
    }
    // Match if the target hostname equals or is a subdomain of the stored
    // origin (or vice versa). Covers tiktok.com ↔ www.tiktok.com and
    // similar same-site shapes without crossing into unrelated origins.
    const isSameSite =
      originHost === target ||
      target.endsWith(`.${originHost}`) ||
      originHost.endsWith(`.${target}`)
    if (!isSameSite) continue
    for (const [key, value] of Object.entries(kv)) {
      if (typeof value === "string") items.push({ key, value })
    }
  }
  return items
}

/**
 * Inject localStorage items for the navigated origin and reload the page so
 * the app re-reads its session state on init. Must be called AFTER the tab
 * has navigated to the target URL — localStorage is origin-scoped, so writes
 * land on whichever origin the tab is currently on.
 *
 * No-op if the provider doesn't support `setStorage` (Camofox added below)
 * or if the payload has no matching localStorage entries.
 */
export async function injectLocalStorage(
  browserProvider: CookieInjectorCapable,
  sessionId: string,
  payload: BrowserSessionPayload,
  currentUrl: string
): Promise<{ injected: number; reloaded: boolean; skippedKeys: string[] }> {
  if (typeof browserProvider.setStorage !== "function") {
    return { injected: 0, reloaded: false, skippedKeys: [] }
  }
  const items = selectLocalStorageForUrl(payload, currentUrl)
  if (items.length === 0)
    return { injected: 0, reloaded: false, skippedKeys: [] }

  const setResult = await browserProvider.setStorage(sessionId, items, "local")
  const skippedKeys: string[] =
    setResult && typeof setResult === "object" && "skippedKeys" in setResult
      ? setResult.skippedKeys
      : []

  // Reload so the page re-reads localStorage on init. Without this, frameworks
  // like TikTok/Stripe that only read sessionState during initial JS execution
  // won't see the just-injected webId/tt_chain_token until the next nav.
  let reloaded = false
  if (typeof browserProvider.navigate === "function") {
    try {
      await browserProvider.navigate(sessionId, currentUrl, {
        waitUntil: "networkidle2",
        timeout: 30000,
      })
      reloaded = true
    } catch {
      // Reload failed — items are still set, just not picked up. Caller will
      // see the page as it was before the storage was written.
    }
  }
  return {
    injected: items.length - skippedKeys.length,
    reloaded,
    skippedKeys,
  }
}
