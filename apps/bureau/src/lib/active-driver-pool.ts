/**
 * Active driver pool — keeps a live HumanSession alive across consecutive
 * browser_act calls for the same session id.
 *
 * Without the pool each call would re-resolve (re-adopt + re-navigate), losing
 * whatever page state the previous action left behind. The pool memoises the
 * resolve Promise per id; on a dead-tab error the entry is evicted so the next
 * call can self-heal with a fresh tab.
 *
 * Also exports `createActEntry` — the `browser_act` McpEntry whose handler
 * drives the pool. Kept here because the pool Map is the shared state that
 * makes browser_act's multi-call action chains coherent; they must be co-
 * located to make the dependency obvious.
 *
 * `createSessionAwareControlEntries` closes the gap the raw control catalogue
 * (browser_navigate / browser_evaluate) otherwise leaves: those tools are
 * bound at startup to ONE anonymous camofox tab ("main", no cookie injection),
 * so a caller passing `session` silently got the wrong (guest) tab while
 * browser_act — routed through this same pool — got the right one. Wrapping
 * navigate/evaluate to route through the pool when `session` is given makes
 * all three share the identical pooled tab per session id.
 *
 * Reliability (observed in live runs): a fresh
 * resolve is wrapped in {@link withLaunchRetry} so a cold camofox relaunch
 * (47-80s observed) doesn't fail just because it outran a single call's
 * budget — see `lib/backend-health.ts`. An operation against an ALREADY
 * resolved driver that fails with a recoverable error (stale tab after a
 * backend restart, a launch-coincident timeout) is retried ONCE, transparently,
 * after evicting the pool entry and re-resolving — `withRecoverableRetry`.
 */

import { z } from "zod"
import type { HumanSession, SessionResolver } from "./ports.js"
import { writeArtifact } from "@agentproto/bureau-core/artifacts"
import {
  asContent,
  toInputSchema,
  type McpContentBlock,
  type McpEntry,
} from "../mcp-tool.js"
import {
  errorMessage,
  isRecoverableBackendError,
  withLaunchRetry,
} from "./backend-health.js"

/** Options shared by {@link createActiveDriverPool}'s launch-retry and
 *  recoverable-retry behaviour — all optional, all test seams. */
export interface ActiveDriverPoolOptions {
  /** Total budget for a launch-coincident retry loop (default: LAUNCH_BUDGET_MS). */
  launchBudgetMs?: number
  /** Delay between retry attempts (default 1000ms; tests inject 0/instant). */
  retryDelayMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (s: string) => void
}

function evictOnDeadTab(
  pool: Map<string, Promise<HumanSession>>,
  session: string,
  err: unknown
): void {
  if (isRecoverableBackendError(err)) pool.delete(session)
}

/**
 * Run `fn(human)` against the pooled driver for `session`; on a recoverable
 * error (dead tab, launch-coincident timeout — see `backend-health.ts`), evict
 * the pool entry, re-resolve ONCE (itself launch-retried), and retry `fn`
 * exactly once. Any other error, or a second failure, propagates as-is.
 *
 * This is what makes INPUTS item 1 ("the next session call must succeed
 * without restarting Bureau") true on the FIRST retried call, not just on some
 * later caller-initiated retry: the self-heal happens inside this one call.
 */
export async function withRecoverableRetry<T>(
  pool: Map<string, Promise<HumanSession>>,
  resolvePooledDriver: (id: string) => Promise<HumanSession>,
  session: string,
  fn: (human: HumanSession) => Promise<T>,
  log: (s: string) => void = () => {}
): Promise<T> {
  const human = await resolvePooledDriver(session)
  try {
    return await fn(human)
  } catch (err) {
    if (!isRecoverableBackendError(err)) throw err
    log(
      `[bureau] session "${session}": recoverable backend error ` +
        `(${errorMessage(err)}) — reopening once`
    )
    pool.delete(session)
    const fresh = await resolvePooledDriver(session)
    return await fn(fresh)
  }
}

/**
 * Build the active driver pool over a base SessionResolver.
 *
 * Returns:
 *  - `resolvePooledDriver(id)` — get-or-create a live HumanSession for `id`.
 *    A FRESH resolve (not yet cached) is wrapped in `withLaunchRetry` so a
 *    cold camofox relaunch doesn't fail just because it outran one call's
 *    budget (INPUTS items 2+3).
 *  - `pooledResolver` — a SessionResolver adapter that routes string refs
 *    through the pool (used by the social dispatch tools so they share the
 *    same memoised tab as browser_act)
 *  - `pool` — the raw Map (needed by error-handling in actEntry to evict a
 *    dead-tab entry)
 */
export function createActiveDriverPool(
  base: SessionResolver,
  opts: ActiveDriverPoolOptions = {}
): {
  resolvePooledDriver: (id: string) => Promise<HumanSession>
  pooledResolver: SessionResolver
  pool: Map<string, Promise<HumanSession>>
} {
  const pool = new Map<string, Promise<HumanSession>>()
  const log = opts.log ?? (() => {})

  const resolvePooledDriver = (id: string): Promise<HumanSession> => {
    let p = pool.get(id)
    if (!p) {
      p = withLaunchRetry({
        attempt: () => base.resolve(id),
        budgetMs: opts.launchBudgetMs,
        retryDelayMs: opts.retryDelayMs,
        now: opts.now,
        sleep: opts.sleep,
        log,
        label: `resolve session "${id}"`,
      }).catch(err => {
        pool.delete(id)
        throw err
      })
      pool.set(id, p)
    }
    return p
  }

  const pooledResolver: SessionResolver = {
    resolve: ref =>
      typeof ref === "string" ? resolvePooledDriver(ref) : base.resolve(ref),
  }

  return { resolvePooledDriver, pooledResolver, pool }
}

/**
 * The `browser_act` McpEntry — the interactive, session-bound counterpart to
 * `scrape`. Where scrape reads a page, browser_act writes: it drives a saved
 * logged-in identity action-by-action (goto / click / fill / press / scroll /
 * read / screenshot / evaluate), human-paced, AS that account. Pass `session`
 * (a saved logged-in identity id) to every call; chain multiple calls to
 * compose a multi-step interaction without losing page state between calls.
 */
/** `browser_act` actions safe to auto-retry once, transparently, after a
 *  recoverable backend error: read-only or naturally idempotent against a
 *  freshly re-opened tab (goto lands on the same url; read/screenshot/evaluate
 *  just observe whatever the fresh tab shows). `click` / `fill` / `press` /
 *  `scroll` are deliberately EXCLUDED — a fresh re-open lands back on the
 *  session's default url, not wherever the prior action chain had navigated
 *  to, so blindly replaying a click there could hit the wrong element (or,
 *  worse, double-submit a form the first attempt actually completed server-
 *  side before the connection dropped). Those still evict on a recoverable
 *  error so the NEXT call self-heals, but this call surfaces the error rather
 *  than guessing. */
const ACT_IDEMPOTENT_ACTIONS = new Set(["goto", "read", "screenshot", "evaluate"])

export function createActEntry(
  resolvePooledDriver: (id: string) => Promise<HumanSession>,
  pool: Map<string, Promise<HumanSession>>,
  log: (s: string) => void = () => {}
): McpEntry {
  return {
    name: "browser_act",
    description:
      "Act INTERACTIVELY in the stealth browser AS a saved logged-in identity " +
      "(session) — the write counterpart to `scrape` (read-only). One `action` " +
      "per call: `goto` (url), `click` (selector), `fill` (selector+text, typed " +
      "human-paced), `press` (key, e.g. Enter), `scroll` (times), `read` (return " +
      "the page's title+text), `screenshot` (return a PNG of the view). `session` " +
      "is required — every action runs as that logged-in account. Use it to send " +
      "a DM, like, follow, or submit a form behind a login. After a mutating " +
      "action, follow with `read` or `screenshot` to confirm the result.",
    jsonSchema: toInputSchema(
      z.object({
        session: z
          .string()
          .describe("Saved logged-in identity to act AS (e.g. x-agentik)."),
        action: z
          .enum([
            "goto",
            "click",
            "fill",
            "press",
            "scroll",
            "read",
            "screenshot",
            "evaluate",
          ])
          .describe("What to do this call."),
        url: z.string().optional().describe("Absolute URL (action goto)."),
        expression: z
          .string()
          .optional()
          .describe(
            "JS expression evaluated in the page; returns its value (action " +
              "evaluate). Use to find selectors / read state on JS-heavy pages."
          ),
        selector: z
          .string()
          .optional()
          .describe("CSS selector (action click/fill)."),
        text: z.string().optional().describe("Text to type (action fill)."),
        key: z
          .string()
          .optional()
          .describe('Key to press, e.g. "Enter" (action press).'),
        times: z
          .number()
          .optional()
          .describe("Scroll bursts (action scroll, default 3)."),
        maxBytes: z
          .number()
          .optional()
          .describe(
            "Cap on returned text bytes (action read, default 200000)."
          ),
      })
    ),
    call: async args => {
      const a = args as {
        session?: unknown
        action?: unknown
        url?: unknown
        selector?: unknown
        text?: unknown
        key?: unknown
        times?: unknown
        maxBytes?: unknown
        expression?: unknown
      }
      const session = typeof a.session === "string" ? a.session : ""
      const action = String(a.action ?? "")
      if (!session) throw new Error("browser_act: `session` is required")

      const runAction = async (
        human: HumanSession
      ): Promise<{ content: McpContentBlock[] }> => {
        switch (action) {
          case "goto": {
            const url = String(a.url ?? "")
            if (!url) throw new Error("browser_act goto: `url` is required")
            await human.navigate(url)
            const title = (await human.evaluate<string>("document.title")) ?? ""
            return asContent({ ok: true, action, url, title })
          }
          case "click": {
            const selector = String(a.selector ?? "")
            if (!selector)
              throw new Error("browser_act click: `selector` is required")
            await human.click(selector)
            return asContent({ ok: true, action, selector })
          }
          case "fill": {
            const selector = String(a.selector ?? "")
            if (!selector)
              throw new Error("browser_act fill: `selector` is required")
            await human.type(selector, String(a.text ?? ""))
            return asContent({ ok: true, action, selector })
          }
          case "press": {
            const key = String(a.key ?? "")
            if (!key) throw new Error("browser_act press: `key` is required")
            await human.press(key)
            return asContent({ ok: true, action, key })
          }
          case "scroll": {
            const times = Number(a.times) || 3
            await human.scroll(times)
            return asContent({ ok: true, action, times })
          }
          case "read": {
            const maxBytes = Number(a.maxBytes) || 200_000
            const url = (await human.evaluate<string>("location.href")) ?? ""
            const title = (await human.evaluate<string>("document.title")) ?? ""
            const raw =
              (await human.evaluate<string>(
                "document.body ? document.body.innerText : ''"
              )) ?? ""
            const truncated = raw.length > maxBytes
            return asContent({
              ok: true,
              action,
              url,
              title,
              text: truncated ? raw.slice(0, maxBytes) : raw,
              truncated,
            })
          }
          case "screenshot": {
            if (!human.screenshot)
              throw new Error(
                "browser_act screenshot: this session has no raster capability"
              )
            const shot = await human.screenshot({ format: "png" })
            return {
              content: [
                {
                  type: "image",
                  data: shot.imageBase64,
                  mimeType: shot.mimeType ?? "image/png",
                },
              ],
            }
          }
          case "evaluate": {
            const expression = String(a.expression ?? "")
            if (!expression)
              throw new Error("browser_act evaluate: `expression` is required")
            const value = await human.evaluate(expression)
            return asContent({ ok: true, action, value })
          }
          default:
            throw new Error(`browser_act: unknown action "${action}"`)
        }
      }

      try {
        if (ACT_IDEMPOTENT_ACTIONS.has(action)) {
          return await withRecoverableRetry(
            pool,
            resolvePooledDriver,
            session,
            runAction,
            log
          )
        }
        const human = await resolvePooledDriver(session)
        return await runAction(human)
      } catch (err) {
        // Evict on a recoverable (dead-tab / launch-coincident) error — a
        // normal action error (selector not found, a real page-level failure)
        // leaves the tab perfectly usable, so evicting would force the next
        // call to re-resolve, re-navigating the session to its default url and
        // losing the page state.
        evictOnDeadTab(pool, session, err)
        throw err
      }
    },
  }
}

/** Tool names in the raw control catalogue that have a direct HumanSession
 *  equivalent and are therefore worth making session-aware. `browser_screenshot`
 *  joined navigate/evaluate 2026-09-28 (M1-GAPS.md gap 4 + its B1 addendum):
 *  without this, screenshot always hit the anonymous "main" control tab, which
 *  doesn't exist until something navigates it (404 on first use) and gets
 *  idle-reaped again a few minutes later — worse than merely session-blind. */
const SESSION_AWARE_TOOL_NAMES = new Set([
  "browser_navigate",
  "browser_evaluate",
  "browser_screenshot",
])

const SESSION_JSON_SCHEMA = {
  type: "string",
  description:
    "Saved logged-in identity to drive (e.g. linkedin-agentik). When set, " +
    "runs against that session's own authenticated tab (same pooled tab as " +
    "browser_act) instead of the anonymous control tab.",
}

/**
 * Wrap the raw control catalogue's `browser_navigate` / `browser_evaluate` /
 * `browser_screenshot` entries so a `session` argument routes them through
 * the SAME pooled resolver `browser_act` uses, instead of the anonymous
 * "main" camofox tab those tools are otherwise permanently bound to.
 *
 * Why this exists: `createControlTools` (browser-mcp) resolves its driver by
 * `target` (a driver KIND — "camofox", "headless", …), cached once per kind at
 * server start. A `session` field in the call args isn't part of that path at
 * all — it survives as far as the tool's own Zod options schema
 * (navigateOptionsSchema / evaluateOptionsSchema), which has no `session`
 * field either, so Zod's default strip behavior silently drops it. The call
 * still "succeeds" — against the wrong, unauthenticated tab. `scrape` /
 * `browser_act` never had this problem because they resolve through
 * `sessionResolver` (camofox-session.ts's `openSession`, which injects
 * cookies for the session's own camofox userId) rather than the driver
 * registry. Entries not in `SESSION_AWARE_TOOL_NAMES`, or called without
 * `session`, pass through unchanged.
 */
export function createSessionAwareControlEntries(
  controlEntries: McpEntry[],
  resolvePooledDriver: (id: string) => Promise<HumanSession>,
  pool: Map<string, Promise<HumanSession>>,
  log: (s: string) => void = () => {}
): McpEntry[] {
  return controlEntries.map(entry => {
    if (!SESSION_AWARE_TOOL_NAMES.has(entry.name)) return entry
    const schema = entry.jsonSchema as {
      properties?: Record<string, unknown>
    }
    return {
      ...entry,
      jsonSchema: {
        ...entry.jsonSchema,
        properties: { ...schema.properties, session: SESSION_JSON_SCHEMA },
      },
      call: async args => {
        const session = (args as { session?: unknown }).session
        if (typeof session !== "string" || !session) return entry.call(args)
        // navigate/screenshot/evaluate are read-only or naturally idempotent
        // (a re-navigate to the same url, a fresh read) — safe to auto-retry
        // once, transparently, after a recoverable backend error (dead tab
        // after a backend restart, a launch-coincident timeout).
        const run = async (human: HumanSession) => {
          if (entry.name === "browser_navigate") {
            const url = String((args as { url?: unknown }).url ?? "")
            if (!url) throw new Error("browser_navigate: `url` is required")
            await human.navigate(url)
            return asContent({ url, session })
          }
          if (entry.name === "browser_screenshot") {
            if (!human.screenshot) {
              throw new Error(
                "browser_screenshot: this session has no raster capability"
              )
            }
            const a = args as {
              selector?: unknown
              format?: unknown
              quality?: unknown
              path?: unknown
            }
            // HumanSession.screenshot has no `selector` clip (see
            // page-eval/index.ts) — same limit browser_act's own screenshot
            // action already lives with; `selector` is a no-op when `session`
            // is set (unchanged behavior: only the anonymous control tab's
            // screenshot honors it).
            const format =
              a.format === "jpeg" || a.format === "png" ? a.format : undefined
            const shot = await human.screenshot({
              format,
              quality: typeof a.quality === "number" ? a.quality : undefined,
            })
            const ext = shot.mimeType.split("/")[1] ?? "png"
            if (typeof a.path === "string" && a.path) {
              const bytes = Buffer.from(shot.imageBase64, "base64")
              const path = writeArtifact(a.path, bytes)
              return asContent({
                path,
                format: ext,
                bytes: bytes.length,
                session,
              })
            }
            return asContent({
              base64: shot.imageBase64,
              format: ext,
              width: 0,
              height: 0,
              session,
            })
          }
          // browser_evaluate
          const expression = String(
            (args as { expression?: unknown }).expression ?? ""
          )
          if (!expression)
            throw new Error("browser_evaluate: `expression` is required")
          const value = await human.evaluate(expression)
          return asContent({ value, truncated: false, session })
        }
        try {
          return await withRecoverableRetry(
            pool,
            resolvePooledDriver,
            session,
            run,
            log
          )
        } catch (err) {
          evictOnDeadTab(pool, session, err)
          throw err
        }
      },
    }
  })
}
