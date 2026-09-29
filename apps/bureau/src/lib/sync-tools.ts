/**
 * `session_sync_from_chrome` — on-demand cookie refresh + re-pin for a
 * chrome-sourced (source-A) session (P4).
 *
 * For a chrome-cookie session, resolution already live-re-reads Chrome on every
 * use, so the real value here is (a) re-PINNING a drifted profile (`profile`
 * arg → update the strategy's `profile`/`profileName`/`profileEmail`) and (b)
 * recording the refresh so `lastCookieRefreshAt` is *visible* in listings. It
 * re-pulls + re-decrypts the declared domains' cookies through the same local
 * decrypt path (`gatherCookies`), reports the count, and is SECRET-FREE — no
 * password, no Keychain, no cookie values cross the wire.
 */

import { z } from "zod"
import {
  gatherCookies,
  scanChromeIdentities,
  priorChromeStrategy,
  isChromeCookieStrategy,
  isChromeProfileInject,
  defaultCamofoxBase,
  type SessionDescriptor,
  type SessionInject,
  type SessionStorePort,
  type ChromeCookieStrategy,
} from "@agentproto/browser-profiles"
import { asContent, toInputSchema, type McpEntry } from "../mcp-tool.js"
import { flushCookieRefresh } from "./session-persist.js"

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface SyncFromChromeParams {
  /** Saved session id to refresh. */
  id: string
  /** Re-pin to this Chrome profile dir when it differs from the current pin. */
  profile?: string
  store: SessionStorePort
}

export interface SyncFromChromeResult {
  status: "ok" | "no-chrome-strategy" | "error"
  /** The Chrome profile dir the cookies were (re-)pulled from. */
  profile?: string
  /** Google account email backing that profile (provenance). */
  profileEmail?: string
  /** How many domain-scoped cookies the re-pull decrypted. */
  cookieCount?: number
  message?: string
}

/** Re-pin a chrome-cookie strategy (+ legacy chrome-profile inject + identity
 *  provenance) to a new profile dir, pulling its friendly name/email from the
 *  live scan. Pure-ish: only reads the Chrome `Local State` scan. */
function repinDescriptor(
  desc: SessionDescriptor,
  newProfile: string
): SessionDescriptor {
  const scan = scanChromeIdentities().find(s => s.profile === newProfile)
  const profileName = scan?.name ?? undefined
  const profileEmail = scan?.email ?? undefined
  const strategies = desc.strategies?.map(s =>
    isChromeCookieStrategy(s)
      ? ({
          ...s,
          profile: newProfile,
          ...(profileName ? { profileName } : {}),
          ...(profileEmail ? { profileEmail } : {}),
        } satisfies ChromeCookieStrategy)
      : s
  )
  const inject: SessionInject | undefined =
    desc.inject && isChromeProfileInject(desc.inject)
      ? { ...desc.inject, profile: newProfile }
      : desc.inject
  return {
    ...desc,
    ...(strategies ? { strategies } : {}),
    ...(inject ? { inject } : {}),
    identity: {
      ...desc.identity,
      profile: newProfile,
      ...(profileName ? { profileName } : {}),
      ...(profileEmail ? { profileEmail } : {}),
    },
  }
}

/**
 * Re-pull + re-decrypt a chrome-sourced session's cookies, optionally re-pinning
 * to a different Chrome profile, then stamp `lastCookieRefreshAt`. Secret-free.
 * `no-chrome-strategy` when the session has no chrome link (owned or managed-only).
 */
export async function syncSessionFromChrome(
  p: SyncFromChromeParams
): Promise<SyncFromChromeResult> {
  let desc = await p.store.load(p.id).catch(() => null)
  if (!desc) {
    return { status: "error", message: `no saved session "${p.id}"` }
  }

  // The chrome link is the chrome-cookie strategy (V2) or a legacy chrome-profile
  // inject — both via priorChromeStrategy. Owned and managed-only sessions have none.
  const chrome: ChromeCookieStrategy | undefined = priorChromeStrategy(desc)
  if (!chrome) {
    return {
      status: "no-chrome-strategy",
      message:
        `session "${p.id}" has no chrome-cookie strategy to refresh ` +
        `(owned and managed sessions re-auth via session_reauth instead).`,
    }
  }

  // Re-pin BEFORE the re-pull so the new profile's cookies are what we count.
  if (p.profile && p.profile !== chrome.profile) {
    desc = repinDescriptor(desc, p.profile)
  }
  const eff: ChromeCookieStrategy | undefined = priorChromeStrategy(desc)
  const profile = eff?.profile ?? chrome.profile

  let cookieCount: number
  try {
    const inject: SessionInject = {
      from: "chrome-profile",
      domains: (eff ?? chrome).domains,
      profile,
      ...((eff ?? chrome).account ? { account: (eff ?? chrome).account } : {}),
    }
    const cookies = await gatherCookies(inject)
    cookieCount = cookies.length
  } catch (e) {
    return { status: "error", profile, message: `re-pull failed: ${msg(e)}` }
  }

  const profileEmail =
    eff?.profileEmail ??
    scanChromeIdentities().find(s => s.profile === profile)?.email ??
    undefined

  // Persist the (possibly re-pinned) descriptor, then flushCookieRefresh stamps
  // lastCookieRefreshAt (its /persist is a best-effort no-op for the chrome path
  // — there's no live camofox jar; the cookies decrypt locally). P4 refresh seam.
  await p.store.save(desc).catch(() => undefined)
  await flushCookieRefresh(p.store, desc.base ?? defaultCamofoxBase(), p.id)

  return {
    status: "ok",
    profile,
    ...(profileEmail ? { profileEmail } : {}),
    cookieCount,
  }
}

const syncInput = z.object({
  session: z
    .string()
    .describe("Saved session id to refresh (a chrome-sourced session)."),
  profile: z
    .string()
    .optional()
    .describe(
      'Re-pin to this Chrome profile dir ("Default", "Profile 1") when it ' +
        "differs from the current pin; omit to refresh the pinned profile."
    ),
})

/**
 * `session_sync_from_chrome` MCP tool — re-pull/re-pin a chrome-sourced session
 * and stamp its refresh time. Secret-free; no cookie values returned.
 */
export function createSyncEntry(deps: { store: SessionStorePort }): McpEntry {
  return {
    name: "session_sync_from_chrome",
    description:
      "Refresh a chrome-sourced saved session: re-pull + re-decrypt its " +
      "declared domains' cookies from the named (or pinned) Chrome profile, " +
      'optionally re-PIN to a different profile (its dir, e.g. "Profile 1"), ' +
      "and stamp the refresh time so freshness shows in bureau_sessions. " +
      "Secret-free — no password, no cookie values. Returns " +
      "no-chrome-strategy for owned/managed sessions (use session_reauth). " +
      "See bureau_sessions, list_credentials.",
    jsonSchema: toInputSchema(syncInput),
    call: async args => {
      const { session, profile } = syncInput.parse(args)
      const result = await syncSessionFromChrome({
        id: session,
        ...(profile ? { profile } : {}),
        store: deps.store,
      })
      return asContent(result)
    },
  }
}
