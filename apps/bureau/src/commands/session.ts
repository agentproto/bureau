/**
 * `bureau session` — manage saved browser identities.
 *
 * The personal surface over the session model: discover the real Chrome
 * profiles as named identities (scan), turn one into a saved, capturable
 * session (save), and inspect/list/remove them. A saved session is what
 * `bureau capture --session <id>` and the agent's `social.capture { session }`
 * resolve against, so "my Agentik X" is addressed by name, never by a cookie
 * jar or an opaque "Profile 3" dir.
 *
 *   bureau session scan                  list Chrome profiles as identities
 *   bureau session list                  list saved sessions
 *   bureau session show <id>             print a saved session + live status
 *   bureau session save <id> --profile "Profile 1" --platform x [--backend …]
 *   bureau session rm <id>
 *
 *   env: BUREAU_SESSIONS_DIR (default ~/.agentproto/bureau/sessions)
 */

import {
  scanChromeIdentities,
  verifyChromeIdentity,
  describeSessionAuth,
  selectResolutionStrategy,
  injectKindOf,
  chromeCookieStrategyOf,
  isChromeProfileInject,
  defaultCamofoxBase,
  type SessionDescriptor,
  type SessionInject,
  type SessionAuthState,
} from "@agentproto/browser-profiles"
import { isLoginWallUrl } from "@agentproto/bureau-core/page-eval"
import {
  isBlockedError,
  openHumanSession,
  type HumanCamofoxSession,
} from "../lib/human-session.js"
import {
  platformKit,
  knownPlatform,
  knownPlatformKeys,
  loginSpecFor,
  loginPlatformKeys,
  supportsMultiAccount,
  enumerateProfileAccounts,
  type KitVisionResolver,
} from "../lib/platform-kit.js"
import { parseArgs, out } from "../lib/args.js"
import { sessionsDir, sessionStore, sessionVerifier } from "../lib/sessions.js"
import { ensureHeadfulCamofox } from "../lib/camofox-headful.js"
import { resolveNotifier } from "../lib/notifier.js"
import {
  buildOwnedDescriptor,
  persistSessionCookies,
  resolveLoginTarget,
  isSiteLoginWallUrl,
} from "../lib/session-persist.js"

import {
  cmdGrants,
  cmdImport,
  cmdRevoke,
  type SessionConsentDeps,
} from "./session-consent.js"
import { cmdLeaseApprove } from "./session-lease.js"

const USAGE = `bureau session — manage saved browser identities

  bureau session scan                       Chrome profiles as named identities
  bureau session accounts <profile> [--platform x]   sub-accounts within a profile
  bureau session list                       saved sessions, then the consent grants (domains, granted-at, device)
  bureau session import --from chrome --domains a.com,b.com [--yes] [--profile P] [--session ID] [--device FP]
                                            grant Bureau the cookies of NAMED domains from a Chrome profile.
                                              Without --yes it asks per domain; non-interactive runs need
                                              --domains and --yes. Wildcards and "all" are refused.
                                              --full-profile --yes grants the whole profile (local only)
  bureau session grants [--all]             consent grants only (--all includes revoked and expired)
  bureau session revoke <domain|grant-id>   revoke a grant: deletes the derived cookies and records it in the ledger
  bureau session lease-approve --session ID --device FP --domains a.com,b.com [--ttl 300] [--valid-for 600]
                                            a human signs a single-use approval so that paired device may lease those
                                              granted domains' cookies (session_lease). Needs a terminal; there is no --yes
  bureau session show <id> [--verify]       a saved session + login status
                                            (heuristic: cookie name + expiry, no network — can't
                                              tell a stale-but-unexpired cookie VALUE from a live one)
                                            --verify: also run a real live probe (navigates the
                                              actual session, slower — the only thing that catches
                                              a session-cookie value that's dead server-side)
  bureau session login <id> --platform <x|linkedin|…> [--auto [--account <a>] [--password-env VAR] [--vision]] [--hold N] [--base <url>] [--reuse-base <url>]
                                            --auto (no 2FA): runs HEADLESS on the durable reuse instance,
                                              so later headless runs reuse the same authed context (no window)
                                            manual / 2FA: opens a headful camofox window to sign in by hand
                                            --vision: set-of-marks model fallback if selectors drift (needs ANTHROPIC_API_KEY)
                                            --base: one instance for login + reuse; --reuse-base: pin the durable reuse home only
  bureau session solve <id> --url <url> [--timeout <min>]
                                            clear an anti-bot wall (DataDome slider) by hand:
                                              opens the headful window, pings you (WhatsApp screenshot /
                                              guild Bell) when the wall trips, waits while you solve, then
                                              persists the cleared session for headless reuse
  bureau session save <id> --profile <p> --platform <x|linkedin|…> [--account <userId>] [--backend camofox|chrome]
  bureau session rm <id>`

/**
 * The operator-facing resolution KIND of a descriptor (P5c vocabulary): the
 * precedence-selected strategy's kind, else the legacy transport `inject.from`
 * mapped through {@link injectKindOf}. The CLI prints THIS rather than the
 * transport-y `inject.from`.
 */
function descriptorKind(desc: SessionDescriptor): string | undefined {
  const sel = selectResolutionStrategy(desc)
  if (sel) return sel.kind
  return desc.inject ? injectKindOf(desc.inject.from) : undefined
}

function cmdScan(): void {
  const ids = scanChromeIdentities()
  if (ids.length === 0) {
    out("no Chrome profiles found")
    return
  }
  out("Chrome identities (pick one to `save` as a session):\n")
  for (const i of ids) {
    const star = i.lastUsed ? "★" : " "
    out(
      `  ${star} ${i.profile.padEnd(11)} ${(i.name ?? "?").padEnd(14)} ` +
        `${(i.email ?? "").padEnd(28)} ${String(i.cookieCount).padStart(5)} cookies`
    )
    out(`      logged into: ${i.domainsLoggedIn.join(", ") || "—"}`)
  }
}

async function cmdAccounts(
  profile: string | undefined,
  flags: Record<string, string>
): Promise<number> {
  if (!profile) {
    out("usage: bureau session accounts <profile> [--platform x]")
    return 1
  }
  const groups = await enumerateProfileAccounts(profile, flags.platform)
  if (groups.length === 0) {
    out(`no multi-account logins found in "${profile}"`)
    return 0
  }
  out(`accounts in ${profile} (pin one with \`save --account <userId>\`):\n`)
  for (const g of groups) {
    out(`  ${g.platform}:`)
    for (const a of g.accounts) {
      out(
        `    ${a.active ? "★ active" : "        "}  ${a.userId}${a.handle ? `  @${a.handle}` : ""}`
      )
    }
  }
  return 0
}

async function cmdList(): Promise<void> {
  const store = sessionStore()
  const sessions = await store.list()
  if (sessions.length === 0) {
    out(`no saved sessions (in ${sessionsDir()})`)
    return
  }
  out(`saved sessions (${sessionsDir()}):\n`)
  for (const s of sessions) {
    const profile =
      s.inject && isChromeProfileInject(s.inject) ? s.inject.profile : undefined
    const sub =
      s.inject && isChromeProfileInject(s.inject) && s.inject.account
        ? ` [${s.inject.account.platform}:${s.inject.account.userId}]`
        : ""
    // Owned (camofox-native) sessions carry no Chrome account/profile — show
    // "(owned login)" rather than a bare "?".
    const account =
      s.identity?.account ??
      profile ??
      (s.inject?.from === "camofox-native" ? "(owned login)" : "?")
    const who = `${account}${sub}`
    const dom =
      s.inject && "domains" in s.inject
        ? s.inject.domains.join(",")
        : s.inject?.from === "camofox-native"
          ? `owned:${s.identity?.platform ?? "?"}`
          : ""
    const kind = descriptorKind(s) ?? "?"
    out(
      `  ${s.id.padEnd(20)} ${s.backend.padEnd(8)} ${kind.padEnd(20)} ${String(who).padEnd(26)} ${dom}`
    )
  }
}

/** Icon for a {@link SessionAuthState} — `authed` is the ONLY state that earns
 *  a checkmark. Everything else (`not-authed`, `unknown`, `not-checked`) must
 *  render as visibly NOT a pass, so a heuristic no-op can never again be read
 *  as a confirmed login (the LinkedIn false-positive this line guards). */
function authIcon(state: SessionAuthState): string {
  switch (state) {
    case "authed":
      return "✓"
    case "not-authed":
      return "✗"
    case "unknown":
      return "?"
    case "not-checked":
      return "·"
  }
}

async function cmdShow(
  id: string | undefined,
  flags: Record<string, string> = {}
): Promise<number> {
  if (!id) {
    out("usage: bureau session show <id> [--verify]")
    return 1
  }
  const store = sessionStore()
  const desc = await store.load(id)
  if (!desc) {
    out(`no saved session "${id}"`)
    return 1
  }
  out(JSON.stringify(desc, null, 2))
  const kind = descriptorKind(desc)
  if (kind)
    out(
      `\nkind: ${kind}` +
        (desc.inject ? `  (transport: ${desc.inject.from})` : "")
    )
  if (desc.inject) {
    const auth = describeSessionAuth(desc.inject, desc.identity)
    out(`\nstatus: ${authIcon(auth.state)} [${auth.state}] ${auth.message}`)
  }
  if (flags.verify) {
    out("\nlive probe (--verify): navigating the real session, please wait…")
    const result = await sessionVerifier({}, store)(id)
    out(
      result
        ? `live status: ${result.authStatus === "authenticated" ? "✓" : "✗"} ` +
            `${result.authStatus} (checked ${result.lastVerifiedAt})`
        : "live probe returned no result (session vanished mid-check?)"
    )
  }
  return 0
}

async function cmdSave(
  id: string | undefined,
  flags: Record<string, string>
): Promise<number> {
  if (!id) {
    out("usage: bureau session save <id> --profile <p> --platform <x|…>")
    return 1
  }
  const backend = (flags.backend ?? "camofox") as SessionDescriptor["backend"]
  if (backend !== "camofox" && backend !== "chrome") {
    out(`invalid --backend "${backend}" (camofox|chrome)`)
    return 1
  }
  const profile = flags.profile
  if (!profile) {
    out("--profile is required (run `bureau session scan` to see profiles)")
    return 1
  }
  const platform = flags.platform
  const domains = flags.domains
    ? flags.domains.split(",").map(s => s.trim())
    : platform && knownPlatform(platform)
      ? [knownPlatform(platform)!.domain]
      : undefined
  if (!domains) {
    out(
      `give --platform <${knownPlatformKeys().join("|")}> or ` +
        `--domains a.com,b.com`
    )
    return 1
  }

  // Pull the live identity for this profile so the saved session is pinned to
  // a real account (email), and fail early if it isn't logged into the platform.
  const identity = scanChromeIdentities().find(s => s.profile === profile)
  if (!identity) {
    const avail = scanChromeIdentities()
      .map(s => `${s.profile} (${s.name ?? "?"})`)
      .join(", ")
    out(`profile "${profile}" not found; available: ${avail}`)
    return 1
  }

  const inject: SessionInject = { from: "chrome-profile", domains, profile }

  // --account: pin a sub-account within a multi-account profile (X switcher).
  if (flags.account) {
    if (!platform || !supportsMultiAccount(platform)) {
      out(
        `--account needs a multi-account --platform (have: ` +
          `${knownPlatformKeys().filter(supportsMultiAccount).join(", ") || "none"})`
      )
      return 1
    }
    const groups = await enumerateProfileAccounts(profile, platform)
    const accounts = groups.find(g => g.platform === platform)?.accounts ?? []
    if (!accounts.some(a => a.userId === flags.account)) {
      out(
        `account "${flags.account}" not logged into ${profile} for ${platform}. ` +
          `Available: ${accounts.map(a => a.userId + (a.active ? "*" : "")).join(", ") || "none"} ` +
          `(see \`bureau session accounts ${profile}\`)`
      )
      return 1
    }
    inject.account = { platform, userId: flags.account }
  }

  try {
    verifyChromeIdentity(inject, {
      profile,
      account: identity.email ?? undefined,
    })
  } catch (e) {
    out(`✗ ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }

  const descIdentity = {
    profile,
    account: identity.email ?? undefined,
    ...(platform ? { platform } : {}),
    // Persist provenance so bureau_sessions reads it off disk (live scan = fallback).
    ...(identity.name ? { profileName: identity.name } : {}),
    ...(identity.email ? { profileEmail: identity.email } : {}),
  }
  const desc: SessionDescriptor = {
    id,
    backend,
    identity: descIdentity,
    inject,
    // Write the descriptor strategy-first (P5c/M3): the `chrome-cookie` strategy
    // alongside the legacy `inject`, mirroring how the owned-login path already
    // emits `strategies[]`. Resolution prefers strategies[]; `inject` stays the
    // back-compat load shim. chromeCookieStrategyOf carries the same provenance.
    strategies: [
      chromeCookieStrategyOf(
        inject as Extract<SessionInject, { from: "chrome-profile" }>,
        descIdentity
      ),
    ],
    savedAt: new Date().toISOString(),
  }
  const store = sessionStore()
  await store.save(desc)
  const sub = inject.account
    ? `, account ${inject.account.platform}:${inject.account.userId}`
    : ""
  out(
    `saved "${id}" → ${backend}, ${identity.name ?? profile} ` +
      `(${identity.email ?? "no account"})${sub}, domains [${domains.join(", ")}]`
  )
  return 0
}

/**
 * `bureau session login <id> --platform <x|linkedin|…>` — the owned-session
 * flow (no cookie injection: the login lives in the camofox session under <id>).
 * A fully-automated login (`--auto`, no expected 2FA) runs HEADLESS on the
 * durable reuse instance, so the authed context is the very one later headless
 * runs reuse — no window, and it doesn't depend on the shared storageState file
 * carrying partitioned auth cookies. A login that needs a human (manual, or a
 * 2FA prompt to finish) opens a headful camofox window instead. Either way it
 * holds, verifies the tab left the login wall, then saves a `camofox-native`
 * descriptor. Unlike `save` (which bridges a daily Chrome profile's cookies the
 * platform invalidates cross-fingerprint), this is a standalone, self-owned
 * login Bureau can re-auth on its own.
 */
async function cmdLogin(
  id: string | undefined,
  flags: Record<string, string>
): Promise<number> {
  if (!id) {
    out(
      "usage: bureau session login <id> (--platform <x|linkedin|…> | --url <login-url> [--platform <key>]) [--auto [--account <a>] [--password-env VAR] [--vision]] [--hold N] [--base <url>] [--reuse-base <url>]"
    )
    return 1
  }
  const target = resolveLoginTarget({
    platform: flags.platform,
    url: flags.url,
  })
  if (!target.ok) {
    out(
      `give --platform <${loginPlatformKeys().join("|")}> or --url <https://site/login-page>`
    )
    return 1
  }
  const { platform, url, arbitrary } = target
  const spec = loginSpecFor(platform)
  const isWall = arbitrary ? isSiteLoginWallUrl : isLoginWallUrl

  // Does a human have to touch this login? Only when it isn't fully autofillable
  // (no `--auto`, or the platform expects a 2FA/device prompt the human finishes).
  const auto = flags.auto === "true" || flags.auto === ""
  const needsHumanWindow = !auto || Boolean(spec?.expectChallenge)

  // Where the login runs vs where later runs reuse it. A login that needs no
  // human runs HEADLESS on the durable reuse instance ITSELF — the authed context
  // then lives in the same camofox the searches hit, so reuse is in-memory and
  // survives camofox's storageState dropping partitioned auth cookies (LinkedIn's
  // li_at never lands in the shared file). A human login needs a visible window,
  // so it runs in an on-demand headful :9378 and reuse falls to the durable home
  // via the shared session dir. `--base` pins one explicit instance for both;
  // `--reuse-base` pins the durable home independently. The descriptor always
  // records its reuse base, so resolution is self-describing.
  const userBase = flags.base
  let loginBase: string
  let reuseBase: string
  let headless = false
  if (userBase) {
    loginBase = userBase
    reuseBase = flags["reuse-base"] ?? userBase
  } else if (!needsHumanWindow) {
    loginBase = reuseBase = flags["reuse-base"] ?? defaultCamofoxBase()
    headless = true
  } else {
    out(`▶ ensuring a headful camofox window…`)
    try {
      loginBase = await ensureHeadfulCamofox()
    } catch (e) {
      out(`✗ ${e instanceof Error ? e.message : String(e)}`)
      return 1
    }
    reuseBase = flags["reuse-base"] ?? defaultCamofoxBase()
  }

  // A human window waits for the person; an automated headless login just needs
  // the page to settle before the auth check.
  const hold = Number(flags.hold ?? (headless ? "8" : "150"))

  // The platform account this login signs in as — persisted onto the owned
  // descriptor so the (platform, account) credential↔session join populates.
  // Seeded from --account; the --auto path refines it to the resolved credential.
  let loginAccount: string | undefined = flags.account

  out(
    headless
      ? `▶ signing in to ${url} headless on ${loginBase} (automated, no window)…`
      : `▶ opening ${url} in the camofox window — log in by hand.`
  )
  let session: HumanCamofoxSession
  try {
    session = await openHumanSession({
      base: loginBase,
      userId: id,
      url,
      injectCookies: false,
    })
  } catch (e) {
    out(
      `✗ couldn't open a camofox session at ${loginBase}: ${e instanceof Error ? e.message : String(e)}`
    )
    return 1
  }

  // --auto: type the stored/env credential into the page before the hold, so the
  // human only has to finish any 2FA / device prompt. The secret is read and
  // typed here — never logged, never returned. Lazy-imported to keep dispatch light.
  if (flags.auto === "true" || flags.auto === "") {
    try {
      const { resolveCredential } = await import("../lib/credentials.js")
      const cred = await resolveCredential(platform, flags.account, {
        passwordEnv: flags["password-env"],
        allowPrompt: true,
      })
      if (!cred) {
        out(
          `  ⚠ --auto: no credential for ${platform}` +
            `${flags.account ? `/${flags.account}` : ""} ` +
            `(store one: bureau creds set ${platform} --account <a>) — finish by hand`
        )
      } else {
        loginAccount = cred.account ?? loginAccount
        // --vision: enable the set-of-marks L4 tier so a fully restructured form
        // (where even the DOM-map heuristic misses) still resolves via a model
        // grounding on a numbered screenshot. Opt-in: costs one model call per
        // field only when L1–L3 all miss. Needs ANTHROPIC_API_KEY.
        let vision: KitVisionResolver | undefined
        if (flags.vision === "true" || flags.vision === "") {
          const { claudeVisionModel } = await import("../lib/vision.js")
          const makeVision = platformKit().makeVisionResolver
          if (!makeVision) throw new Error("--vision needs a platform kit that provides vision grounding")
          vision = makeVision({
            session,
            screenshot: () =>
              session.screenshot({ format: "jpeg", quality: 70 }),
            model: claudeVisionModel(),
          })
          out(`  vision fallback on (set-of-marks → Claude)`)
        }
        out(`  autofilling ${platform} as ${cred.account}…`)
        const autofill = platformKit().autofill
        if (!autofill) throw new Error(`no autofill support for ${platform} (no platform kit installed)`)
        const r = await autofill(session, platform, cred, { vision })
        out(
          `  typed ${r.ran} step(s)` +
            (r.expectChallenge ? " — finish any 2FA in the window" : "")
        )
      }
    } catch (e) {
      out(
        `  ⚠ --auto failed (${e instanceof Error ? e.message : String(e)}) — finish by hand`
      )
    }
  }

  out(`  holding ${hold}s, then I'll verify the login took…`)
  await new Promise(r => setTimeout(r, hold * 1000))
  const href = await session.evaluate<string>("location.href").catch(() => "")
  if (!href || isWall(String(href))) {
    out(
      `⚠ still on ${href || "?"} — not signed in yet (nothing saved). ` +
        `Re-run with --hold 300 and finish logging in.`
    )
    return 1
  }

  // Force-flush the authed jar to disk now, against the instance that holds the
  // live context (loginBase). camofox otherwise flushes on a ≤20s timer — a
  // restart inside that window would lose the just-saved login. Best-effort.
  const persisted = await persistSessionCookies(loginBase, id)
  if (persisted != null) out(`  persisted ${persisted} cookies to disk`)

  // Land reuse on the platform's authed home (not openSession's generic default)
  // so a cold tab doesn't open on an unrelated site and trip its anti-bot. Load
  // any prior descriptor first so logging in over a chrome-profile identity
  // AUGMENTS it (chrome provenance survives) instead of overwriting it.
  const store = sessionStore()
  const prev = (await store.load(id).catch(() => null)) ?? undefined
  await store.save(
    buildOwnedDescriptor(
      id,
      platform,
      reuseBase,
      loginAccount,
      prev,
      arbitrary ? url : undefined
    )
  )
  out(
    `✓ saved owned session "${id}" → camofox-native, ${platform} (authed at ${href})`
  )
  out(`  reuse base: ${reuseBase}`)
  out(
    `  use it: bureau search "<query>" --session ${id} --platform ${platform}`
  )
  return 0
}

/**
 * `bureau session solve <id> --url <url>` — human-in-the-loop for an anti-bot
 * wall (DataDome slider). The headless reuse instance can't solve a slider (no
 * window), so this opens the on-demand headful camofox, navigates until the wall
 * trips, then fires the notifier (WhatsApp screenshot / guild Bell) and WAITS,
 * polling the live page until you've solved it. On success the cleared session
 * is force-flushed to the shared profile dir, so every later headless run reuses
 * it — the "solve once, reuse everywhere" path. Persisted under <id> (the camofox
 * userId an operator/driver opens its session with, e.g. "leboncoin").
 */
async function cmdSolve(
  id: string | undefined,
  flags: Record<string, string>
): Promise<number> {
  if (!id) {
    out("usage: bureau session solve <id> --url <url> [--timeout <min>]")
    return 1
  }
  // A bare site id (leboncoin) → best-effort apex; --url pins the exact page
  // (the one that trips the wall, e.g. a search result).
  const url = flags.url ?? `https://www.${id}.fr/`
  const timeoutMin = Number(flags.timeout ?? "10")

  out(`▶ ensuring a headful camofox window…`)
  let headful: string
  try {
    headful = await ensureHeadfulCamofox()
  } catch (e) {
    out(`✗ ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }

  const notifier = resolveNotifier()
  let notified = false
  out(`▶ opening ${url} — I'll ping you the moment a wall comes up.`)

  let session: HumanCamofoxSession
  try {
    session = await openHumanSession({
      base: headful,
      userId: id,
      url,
      injectCookies: false,
      onChallenge: async info => {
        if (!notified) {
          notified = true
          out(
            `  🧩 anti-bot wall on ${info.site} — notifying you + waiting (≤${timeoutMin}m)…`
          )
          await notifier.notify({
            kind: "challenge",
            site: info.site,
            url: info.url,
            reason: info.reason,
            solveCommand: `bureau session solve ${id}${flags.url ? ` --url ${flags.url}` : ""}`,
            screenshot: info.screenshot,
          })
        }
        const deadline = Date.now() + timeoutMin * 60_000
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 5000))
          if (!(await info.recheck())) {
            out(`  ✓ wall cleared`)
            return "cleared"
          }
        }
        return "give-up"
      },
    })
  } catch (e) {
    out(
      `✗ couldn't open a camofox session at ${headful}: ${e instanceof Error ? e.message : String(e)}`
    )
    return 1
  }

  // Paced nav so onChallenge engages on the wall; it throws BLOCKED if the wall
  // outlives the human window.
  try {
    await session.gotoPaced(url)
  } catch (e) {
    if (isBlockedError(e)) {
      out(
        `✗ challenge not solved within ${timeoutMin} min — re-run when ready.`
      )
      return 1
    }
    out(`✗ ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }

  // Force-flush the cleared session now so a headless restart can't lose it
  // before camofox's ≤20s timer flush (loopback-gated server-side, best-effort).
  try {
    const res = await fetch(
      `${headful.replace(/\/$/, "")}/sessions/${id}/persist`,
      { method: "POST", headers: { "content-type": "application/json" } }
    )
    if (res.ok) {
      const r = (await res.json().catch(() => ({}))) as { cookieCount?: number }
      out(
        `  persisted ${r.cookieCount ?? "?"} cookies to the shared profile dir`
      )
    }
  } catch {
    /* older camofox without /persist — the timer flush still covers it */
  }

  out(
    `✓ "${id}" cleared the wall — headless runs (:9377) now reuse the solved session`
  )
  return 0
}

async function cmdRm(id: string | undefined): Promise<number> {
  if (!id) {
    out("usage: bureau session rm <id>")
    return 1
  }
  const store = sessionStore()
  if (!(await store.load(id))) {
    out(`no saved session "${id}"`)
    return 1
  }
  await store.remove(id)
  out(`removed "${id}"`)
  return 0
}

/** Dispatch a `bureau session …` invocation. Returns a process exit code. */
export async function runSession(
  argv: string[],
  consentDeps: SessionConsentDeps = {}
): Promise<number> {
  const { positionals, flags } = parseArgs(argv)
  const [sub, arg] = positionals
  switch (sub) {
    case "scan":
      cmdScan()
      return 0
    case "accounts":
      return cmdAccounts(arg, flags)
    case "list":
      await cmdList()
      out("")
      return cmdGrants(flags, consentDeps)
    case "import":
      return cmdImport(flags, consentDeps)
    case "grants":
      return cmdGrants(flags, consentDeps)
    case "revoke":
      return cmdRevoke(arg, consentDeps)
    case "lease-approve":
      return cmdLeaseApprove(flags, consentDeps)
    case "show":
      return cmdShow(arg, flags)
    case "save":
      return cmdSave(arg, flags)
    case "login":
      return cmdLogin(arg, flags)
    case "solve":
      return cmdSolve(arg, flags)
    case "rm":
    case "remove":
      return cmdRm(arg)
    default:
      out(USAGE)
      return sub ? 1 : 0
  }
}
