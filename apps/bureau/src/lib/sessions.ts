/**
 * Session composition root for the CLI — the one place that turns saved
 * descriptors into live sessions. Wires the session store(s) and the
 * `SessionResolver` (`id | descriptor → live HumanSession`) the capture command
 * and the `social.capture` DRIVER both consume.
 *
 * The `camofox` backend resolves fully here (cookies injected into a stealth
 * session). The `chrome` backend needs a live per-profile BrowserDriver wired
 * into `resolveSession` deps — deferred until the Bureau drives a real Chrome —
 * so a chrome descriptor surfaces resolveSession's explicit "needs a driver"
 * error rather than silently doing the wrong thing.
 *
 * Connected: when managed session sources and catalogs are wired (`deps`,
 * supplied by a registered {@link SessionSource}), the resolver ALSO resolves
 * centrally managed sessions: each catalog is layered over the local file store
 * and the matching source supplies cookies at resolve-time. Standalone stays
 * pure-local.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import {
  fileSessionStore,
  catalogSessionStore,
  compositeSessionStore,
  createSessionSourceRegistry,
  resolveSession,
  verifyChromeIdentity,
  type AuthStatus,
  type SessionStorePort,
  type SessionSource as CookieSource,
  type SessionSourceCatalog,
} from "@agentproto/browser-profiles"
import { isLoginWallUrl } from "@agentproto/bureau-core/page-eval"
import {
  fromCamofoxSession,
  openHumanSession,
  type HumanCamofoxSession,
} from "./human-session.js"
import { platformKit } from "./platform-kit.js"
import type { SessionResolver } from "./ports.js"

/**
 * Managed-session wiring for a connected Bureau; both are absent in a
 * standalone Bureau (pure-local sessions). `sources` supply cookies at
 * resolve-time (decrypt, domain-scope and any sealing happen inside them);
 * `catalogs` let saved managed sessions resolve by name.
 */
export interface BureauSessionDeps {
  sources?: CookieSource[]
  catalogs?: Array<{ kind: string; catalog: SessionSourceCatalog }>
}

export function sessionsDir(): string {
  return (
    process.env.BUREAU_SESSIONS_DIR ??
    join(homedir(), ".agentproto", "bureau", "sessions")
  )
}

/**
 * A registered provider of managed-session wiring (e.g. a cloud vault). A
 * standalone Bureau registers none and stays pure-local; a plugin contributes
 * one via `BureauPlugin.sessionSources`.
 */
export interface SessionSource {
  name: string
  /** Wiring built from the daemon's environment, or `undefined` when this
   *  source isn't configured here. */
  deps(): BureauSessionDeps | undefined
}

const sessionSources = new Map<string, SessionSource>()

/** Register (or replace, by name) a session source. */
export function registerSessionSource(source: SessionSource): void {
  sessionSources.set(source.name, source)
}

/** Drop every registered source (tests). */
export function clearSessionSources(): void {
  sessionSources.clear()
}

/**
 * The managed-session wiring from the first registered source that is
 * configured in this environment, else `{}` (pure-local sessions).
 */
export function bureauSessionDeps(): BureauSessionDeps {
  for (const source of sessionSources.values()) {
    const d = source.deps()
    if (d && (d.sources?.length || d.catalogs?.length)) return d
  }
  return {}
}

/** Sync read of the (platform, account) credential index — the same file
 *  `keychainCredentialStore` writes. Fed to the file store's load-time
 *  `normalizeDescriptor` so a matching credential synthesizes a
 *  `stored-credential` strategy (the A↔B reconciliation). Never the secrets;
 *  swallows a missing/corrupt index (reconciliation is a bonus). */
function readCredsIndexSync(): Array<{ platform: string; account: string }> {
  try {
    const path = join(homedir(), ".agentproto", "bureau", "creds-index.json")
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return []
  }
}

export function sessionStore(deps: BureauSessionDeps = {}): SessionStorePort {
  const file = fileSessionStore(sessionsDir(), {
    credentials: readCredsIndexSync,
  })
  if (!deps.catalogs?.length) return file
  // Managed sessions resolve first, local file sessions still resolve by name;
  // writes (capture) target the writable file store.
  return compositeSessionStore(
    [...deps.catalogs.map(c => catalogSessionStore(c.kind, c.catalog)), file],
    file
  )
}

export function sessionResolver(
  deps: BureauSessionDeps = {},
  store: SessionStorePort = sessionStore(deps)
): SessionResolver {
  return {
    async resolve(ref) {
      const desc = typeof ref === "string" ? await store.load(ref) : ref
      if (!desc) throw new Error(`no saved session "${String(ref)}"`)
      const accounts = platformKit().accounts
      const resolved = await resolveSession(desc, {
        sources: createSessionSourceRegistry(deps.sources ?? []),
        openCamofox: opts => openHumanSession(opts),
        ...(accounts ? { accountSwitcher: accounts.switcher } : {}),
      })
      if (resolved.backend !== "camofox") {
        throw new Error(
          `session "${desc.id}" uses the chrome backend, which needs a live driver`
        )
      }
      return fromCamofoxSession(resolved.session as HumanCamofoxSession)
    },
  }
}

export type { SessionStorePort }

/** The result of a cheap live auth probe, also written back to the descriptor. */
export interface SessionVerifyResult {
  authStatus: AuthStatus
  lastVerifiedAt: string
}

/**
 * A cheap, secret-free auth probe that stamps `lastAuthStatus` / `lastVerifiedAt`
 * back onto the descriptor — what `bureau_sessions { verify:true }` runs per
 * session. For chrome-sourced sessions it uses the synchronous `verifyChromeIdentity`
 * (no browser); for owned and managed sessions it resolves a live session and checks the
 * landing URL isn't a login wall. Returns null for an unknown id; never throws
 * (a probe failure resolves to `auth-wall`).
 */
export function sessionVerifier(
  deps: BureauSessionDeps = {},
  store: SessionStorePort = sessionStore(deps)
): (id: string) => Promise<SessionVerifyResult | null> {
  const resolver = sessionResolver(deps, store)
  return async id => {
    const desc = await store.load(id)
    if (!desc) return null
    let authStatus: AuthStatus = "unknown"
    try {
      const from = desc.inject?.from
      if (desc.inject && (from === "chrome-profile" || from === "file")) {
        verifyChromeIdentity(desc.inject, desc.identity)
        authStatus = "authenticated"
      } else {
        const page = await resolver.resolve(desc)
        const href = await page
          .evaluate<string>("location.href")
          .catch(() => "")
        authStatus =
          href && !isLoginWallUrl(String(href)) ? "authenticated" : "auth-wall"
      }
    } catch {
      authStatus = "auth-wall"
    }
    const lastVerifiedAt = new Date().toISOString()
    await store
      .save({ ...desc, lastAuthStatus: authStatus, lastVerifiedAt })
      .catch(() => undefined)
    return { authStatus, lastVerifiedAt }
  }
}
