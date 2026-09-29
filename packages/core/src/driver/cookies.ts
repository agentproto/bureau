/**
 * Cross-driver session bridging — the "use my Chrome login in a stealth
 * capture" feature, as a first-class browser primitive.
 *
 * `bridgeCookies` exports the cookie jar from one driver (e.g. the user's
 * logged-in Chrome via the extension/tunneled backend — which CAN read
 * HttpOnly cookies through CDP Network.getAllCookies) and imports it into
 * another (e.g. a stealth camofox capture). Both ends must declare the
 * `SupportsCookies` capability; the guard makes the requirement explicit
 * rather than failing deep in a capture.
 *
 * `listCookies` is the read half on its own — for a "what's in my session"
 * surface (CLI / MCP tool), complementing BrowserSessionProvider.list which
 * lists STORED sessions; this reads the LIVE jar.
 */

import type { BrowserDriver } from "./types.js"
import { supportsCookies } from "./capabilities.js"
import type { CookieJson } from "../session/types.js"

export interface BridgeCookiesOptions {
  /** Source driver — the authenticated session (e.g. the user's Chrome). */
  readonly from: BrowserDriver
  /** Target driver — receives the jar (e.g. the stealth capture engine). */
  readonly to: BrowserDriver
  /** Restrict to one domain (suffix match), e.g. "x.com". Recommended. */
  readonly domain?: string
  /** Or restrict by url. */
  readonly url?: string
}

export interface BridgeCookiesResult {
  readonly exported: number
  readonly injected: number
  readonly domain?: string
}

/** Read the live cookie jar from a driver. Throws if it can't export. */
export async function listCookies(
  driver: BrowserDriver,
  opts?: { domain?: string; url?: string }
): Promise<CookieJson[]> {
  if (!supportsCookies(driver))
    throw new Error(
      `driver "${driver.kind}" cannot export cookies (declare canCookies + implement SupportsCookies)`
    )
  return driver.getCookies(opts)
}

/** Bridge a (domain-scoped) cookie jar from one driver to another. */
export async function bridgeCookies(
  opts: BridgeCookiesOptions
): Promise<BridgeCookiesResult> {
  if (!supportsCookies(opts.from))
    throw new Error(`source driver "${opts.from.kind}" cannot export cookies`)
  if (!supportsCookies(opts.to))
    throw new Error(`target driver "${opts.to.kind}" cannot import cookies`)
  const jar = await opts.from.getCookies({ domain: opts.domain, url: opts.url })
  const { injected } = await opts.to.setCookies(jar)
  return { exported: jar.length, injected, domain: opts.domain }
}
