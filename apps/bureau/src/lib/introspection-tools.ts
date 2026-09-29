/**
 * Introspection tools — read-only metadata about what this Bureau holds.
 *
 * bureau_sessions: which logged-in identities are saved (id, backend, platform,
 *   account, source [the strategy-kind vocabulary — chrome-cookie / authed-
 *   storageState / a registered source kind; sourceLegacy keeps the old transport tag], the resolved
 *   sub-account, declared domains, the Chrome profile a session draws from, and
 *   whether a re-login credential is on file). Metadata only — no cookies or
 *   credentials.
 * list_credentials: which (platform, account) sign-in credentials are on file
 *   and which saved sessions each is linked to. NEVER the secret/password.
 * bureau_tabs: which tabs are currently open, optionally scoped to one identity.
 *   Sweeps both saved sessions AND the anonymous control scope ("main" userId,
 *   shown as "(control)") so callers see the full picture.
 */

import { z } from "zod"
import {
  scanChromeIdentities,
  cookieFreshness,
  selectResolutionStrategy,
  injectKindOf,
  isChromeCookieStrategy,
  isStoredCredentialStrategy,
  isOwnedStorageStateStrategy,
  type Strategy,
  type SessionDescriptor,
  type SessionInjectFrom,
} from "@agentproto/browser-profiles"
import { asContent, toInputSchema, type McpEntry } from "../mcp-tool.js"

/** The control userId camofox uses for bare (non-session) navigate/scrape calls. */
const CONTROL_USER_ID = "main"
/** Display label for the control scope in bureau_tabs output. */
const CONTROL_SCOPE_LABEL = "(control)"

interface SavedIdentity {
  id: string
  backend?: string
  identity?: {
    platform?: string
    account?: string
    profile?: string
    profileName?: string
    profileEmail?: string
  }
  inject?:
    | { from?: string; domains?: string[]; profile?: string }
    | Record<string, unknown>
  /** V2 coexisting auth strategies — kinds + provenance only, never secrets. */
  strategies?: Strategy[]
  lastAuthStatus?: string
  lastVerifiedAt?: string
  lastCookieRefreshAt?: string
}

interface IdentityStore {
  list(): Promise<SavedIdentity[]>
}

/** Read side of the credential index — the (platform, account) pairs on file,
 *  NEVER the secrets. Matches `CredentialStorePort.list()`. */
interface CredentialLister {
  list(): Promise<Array<{ platform: string; account: string }>>
}

interface TabLister {
  listTabs(
    userId: string
  ): Promise<Array<{ tabId: string; url: string; title: string }>>
}

/**
 * A secret-free summary of one V2 strategy for the listing surface. Strategy
 * objects already hold no secrets (a `stored-credential` carries only the account
 * REF), so this is mostly pass-through; it pins the field set explicitly per kind
 * so a future field-with-a-secret can't leak by accident.
 */
function summarizeStrategy(s: Strategy): Record<string, unknown> {
  if (isChromeCookieStrategy(s)) {
    return {
      kind: s.kind,
      domains: s.domains,
      profile: s.profile,
      ...(s.profileName ? { profileName: s.profileName } : {}),
      ...(s.profileEmail ? { profileEmail: s.profileEmail } : {}),
      ...(s.account ? { account: s.account } : {}),
    }
  }
  if (isStoredCredentialStrategy(s)) {
    return { kind: s.kind, platform: s.platform, account: s.account }
  }
  if (isOwnedStorageStateStrategy(s)) {
    return {
      kind: s.kind,
      ...(s.capturedAt ? { capturedAt: s.capturedAt } : {}),
    }
  }
  return { kind: s.kind, domains: s.domains, sessionRef: s.sessionRef }
}

/** The Chrome profile dir a saved identity draws its cookies from, if any. */
function chromeProfileDir(d: SavedIdentity): string | undefined {
  if (d.identity?.profile) return d.identity.profile
  const inject = d.inject
  if (
    inject &&
    inject.from === "chrome-profile" &&
    typeof inject.profile === "string"
  )
    return inject.profile
  return undefined
}

export function createIntrospectionEntries(deps: {
  store: IdentityStore
  camofox: TabLister
  /** Credential index reader — `hasCredential` / `list_credentials` join off it. */
  creds: CredentialLister
  /**
   * Optional live-probe + write-back for `bureau_sessions { verify:true }`. Wired
   * at the composition root (needs a resolver + writable store); when absent the
   * `verify` flag is ignored and listings fall back to persisted status. Returns
   * null for an unknown id; never throws.
   */
  verifySession?: (
    id: string
  ) => Promise<{ authStatus: string; lastVerifiedAt: string } | null>
}): McpEntry[] {
  const { store, camofox, creds, verifySession } = deps

  /** Best-effort friendly name + Google email for a Chrome profile dir. Swallows
   *  any scan error (no Chrome, locked Local State) — provenance is a bonus. */
  const chromeProfileLookup = (): Map<
    string,
    { name?: string; email?: string }
  > => {
    try {
      const map = new Map<string, { name?: string; email?: string }>()
      for (const i of scanChromeIdentities())
        map.set(i.profile, {
          ...(i.name ? { name: i.name } : {}),
          ...(i.email ? { email: i.email } : {}),
        })
      return map
    } catch {
      return new Map()
    }
  }

  const sessionsEntry: McpEntry = {
    name: "bureau_sessions",
    description:
      "List the browser identities saved on this Bureau (id, backend, " +
      "platform, account, source [the resolution strategy KIND — chrome-cookie / " +
      "authed-storageState / managed; sourceLegacy = the old transport tag], the " +
      "resolved sub-account, declared domains, the Chrome profile a session draws " +
      "from, the last auth status + when it was verified, and " +
      "whether a re-login credential is on file). Metadata only — no cookies or " +
      "credentials. Pass verify:true to run a cheap live auth probe per session " +
      "and refresh authStatus before returning (slower; spawns a browser for " +
      "owned sessions). Use bureau_tabs to see what's open right now, " +
      "list_credentials for stored sign-in credentials.",
    jsonSchema: toInputSchema(
      z.object({
        verify: z
          .boolean()
          .optional()
          .describe(
            "Run a live auth probe per session and stamp authStatus before " +
              "returning (default false; reads persisted status otherwise)."
          ),
      })
    ),
    call: async args => {
      const verify =
        verifySession && (args as { verify?: unknown }).verify === true
      const list = await store.list()
      const credIndex = await creds.list().catch(() => [])
      const profiles = chromeProfileLookup()
      // When verifying, probe every session up front (each stamps its descriptor)
      // and key the fresh verdicts by id for the row mapping below.
      const probed = new Map<
        string,
        { authStatus: string; lastVerifiedAt: string }
      >()
      if (verify) {
        await Promise.all(
          list.map(async d => {
            const r = await verifySession!(d.id).catch(() => null)
            if (r) probed.set(d.id, r)
          })
        )
      }
      const now = Date.now()
      return asContent({
        sessions: list.map(d => {
          const platform = d.identity?.platform
          const account = d.identity?.account
          const dir = chromeProfileDir(d)
          // Lift the resolved chrome-cookie strategy's sub-account ({platform,
          // userId} — the X multi-account pin) onto the row, so a reader sees
          // WHICH account within the profile resolves without digging into
          // strategies[]. Only the chrome-cookie path carries a sub-account.
          const sel = selectResolutionStrategy(
            d as unknown as SessionDescriptor
          )
          const subAccount =
            sel && isChromeCookieStrategy(sel) && sel.account
              ? sel.account
              : undefined
          // Prefer provenance persisted at save time; fall back to the live scan
          // (legacy descriptors saved before provenance was persisted).
          const persisted =
            d.identity?.profileName || d.identity?.profileEmail
              ? {
                  ...(d.identity.profileName
                    ? { name: d.identity.profileName }
                    : {}),
                  ...(d.identity.profileEmail
                    ? { email: d.identity.profileEmail }
                    : {}),
                }
              : undefined
          const meta = persisted ?? (dir ? profiles.get(dir) : undefined)
          return {
            id: d.id,
            backend: d.backend,
            platform,
            account,
            // `source` now speaks the operator-facing strategy-kind vocabulary
            // (the precedence-selected strategy's kind, else the legacy transport
            // tag mapped through injectKindOf). `sourceLegacy` keeps the
            // raw `inject.from` for one release. @deprecated: read `strategies[]`.
            source:
              sel?.kind ??
              (d.inject?.from
                ? injectKindOf(d.inject.from as SessionInjectFrom)
                : undefined),
            ...(d.inject?.from ? { sourceLegacy: d.inject.from } : {}),
            domains:
              d.inject && "domains" in d.inject ? d.inject.domains : undefined,
            // V2 coexisting strategies (kinds + provenance, never secrets) — so
            // a session augmented by a credential re-login shows BOTH its owned
            // login and its preserved chrome link, not just the resolve source.
            ...(d.strategies && d.strategies.length
              ? { strategies: d.strategies.map(summarizeStrategy) }
              : {}),
            // The resolved sub-account ({platform, userId}) for multi-account
            // profiles (X), lifted off strategies[] onto the row.
            ...(subAccount ? { subAccount } : {}),
            ...(dir ? { chromeProfile: { dir, ...(meta ?? {}) } } : {}),
            // Fresh verdict (verify:true) wins; else the persisted last probe.
            authStatus:
              probed.get(d.id)?.authStatus ?? d.lastAuthStatus ?? "unknown",
            lastVerifiedAt:
              probed.get(d.id)?.lastVerifiedAt ?? d.lastVerifiedAt,
            // Read-time staleness verdict (no probe): chrome-cookie is always
            // fresh (live re-read); owned and managed go by lastCookieRefreshAt vs TTL.
            cookieFreshness: cookieFreshness(
              d as unknown as SessionDescriptor,
              now
            ),
            ...(d.lastCookieRefreshAt
              ? { lastCookieRefreshAt: d.lastCookieRefreshAt }
              : {}),
            hasCredential:
              !!platform &&
              !!account &&
              credIndex.some(
                c => c.platform === platform && c.account === account
              ),
          }
        }),
      })
    },
  }

  const tabsEntry: McpEntry = {
    name: "bureau_tabs",
    description:
      "List the browser tabs currently open on this Bureau (session, url, " +
      "title). Pass `session` to scope to one saved identity; omit it to sweep " +
      `every saved session plus the ad-hoc control tab (session "${CONTROL_SCOPE_LABEL}", ` +
      "where bare browser_navigate / scrape drive). Only live sessions return tabs.",
    jsonSchema: toInputSchema(
      z.object({
        session: z
          .string()
          .optional()
          .describe("Saved session id to scope to; omit to list all."),
      })
    ),
    call: async args => {
      const only = (args as { session?: unknown }).session
      // On a full sweep, include the bare control scope (browser_navigate /
      // scrape with no session) alongside saved identities. Its tabs would
      // otherwise be invisible because it drives camofox under its own userId.
      const probes: Array<{ userId: string; label: string }> =
        typeof only === "string" && only
          ? [{ userId: only, label: only }]
          : [
              ...(await store.list()).map(d => ({ userId: d.id, label: d.id })),
              { userId: CONTROL_USER_ID, label: CONTROL_SCOPE_LABEL },
            ]
      const tabs: Array<{
        session: string
        tabId: string
        url: string
        title: string
      }> = []
      for (const p of probes) {
        // A non-live session returns []; a camofox blip shouldn't sink the sweep.
        const open = await camofox.listTabs(p.userId).catch(() => [])
        for (const t of open) {
          tabs.push({
            session: p.label,
            tabId: t.tabId,
            url: t.url,
            title: t.title,
          })
        }
      }
      return asContent({ tabs })
    },
  }

  return [sessionsEntry, tabsEntry]
}
