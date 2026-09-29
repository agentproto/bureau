/**
 * PageEval + HumanSession — the browser interaction seam.
 *
 * Lives in browser-core (not browser-social) because it is a pure interface
 * contract with zero implementation dependencies: consumed by bureau,
 * browser-actions, and browser-social alike.  Implementations
 * (fromCamofoxSession, fromBrowserDriver, humanFromPageEval, fromCamofoxClient)
 * stay in browser-social where they belong alongside the adapters that use them.
 */

/** Failure classes a caller can branch on: back off vs abort vs escalate tier. */
export type PageEvalErrorKind =
  | "script" // the in-page expression threw
  | "blocked" // anti-bot / login wall / challenge interstitial
  | "rate-limited" // 429 / throttle signal — back off + retry
  | "navigation" // navigate failed (timeout, net error)
  | "transport" // the driver/service itself errored

export class PageEvalError extends Error {
  constructor(
    readonly kind: PageEvalErrorKind,
    message: string,
    readonly cause?: unknown
  ) {
    super(`[page-eval:${kind}] ${message}`)
    this.name = "PageEvalError"
  }
}

/**
 * Normalize an unknown thrown value into a {@link PageEvalError}: pass a
 * PageEvalError through unchanged (preserving its `kind`), otherwise wrap it as
 * the given `kind` (default `"script"`).
 */
export function asPageEvalError(
  e: unknown,
  kind: PageEvalErrorKind = "script"
): PageEvalError {
  return e instanceof PageEvalError
    ? e
    : new PageEvalError(kind, e instanceof Error ? e.message : String(e), e)
}

/**
 * Run an in-page expression and return its value, rewrapping any non-typed throw
 * as a {@link PageEvalError}. The single source of the `try { evaluate } catch {
 * rewrap }` idiom every adapter reimplemented.
 */
export async function evalOrThrow<T>(
  page: PageEval,
  expr: string
): Promise<T | undefined> {
  try {
    return await page.evaluate<T>(expr)
  } catch (e) {
    throw asPageEvalError(e)
  }
}

/** Best-effort classification of a raw transport/script error message. */
export function classifyEvalError(raw: string): PageEvalErrorKind {
  const s = raw.toLowerCase()
  if (/\b429\b|rate.?limit|too many requests|throttl/.test(s))
    return "rate-limited"
  if (
    /challenge|captcha|are you human|unusual traffic|login|sign in|403|blocked/.test(
      s
    )
  )
    return "blocked"
  if (/navigat|net::|timeout|timed out|connection/.test(s)) return "navigation"
  return "script"
}

/**
 * True when a landed URL is a platform login / checkpoint / auth wall — i.e.
 * the session is unauthenticated.
 */
export function isLoginWallUrl(url: string): boolean {
  return /\/(uas\/login|login|checkpoint|authwall)\b/i.test(url)
}

/**
 * True when an error means the session is unauthenticated and a re-login would
 * fix it. Unifies the typed `blocked` PageEvalError and the camofox warm-session
 * `DATADOME_BLOCK` message; matches by message across a package boundary too,
 * where the typed class may not survive serialization.
 */
export function isReauthRequired(error: unknown): boolean {
  if (error instanceof PageEvalError) return error.kind === "blocked"
  return (
    error instanceof Error &&
    (/\[page-eval:blocked\]/.test(error.message) ||
      /DATADOME_BLOCK/.test(error.message))
  )
}

/**
 * The collapsed transport seam. Adapters depend on this two-method surface;
 * browser-social bridges it from the canonical transports (fromBrowserDriver,
 * fromCamofoxClient, fromCamofoxSession).
 *
 * Why an evaluate-based click/fill layer is deliberately NOT here: BrowserDriver
 * already implements click/fill with TRUSTED input (CDP Input.* / camofox AX).
 * A JS-synthesised `el.click()` fires untrusted events that framework + anti-bot
 * checks ignore. The footprint adapters are API-first — navigate + evaluate is
 * the whole surface they need.
 */
export interface PageEval {
  /** Navigate the active tab/page. Throws PageEvalError on failure. */
  navigate(url: string): Promise<void>
  /**
   * Run an expression in the page and return the value. Returns undefined when
   * the engine yields nothing; throws a typed PageEvalError on failure.
   */
  evaluate<T = unknown>(expression: string): Promise<T | undefined>
}

/**
 * HumanSession — the richer interaction surface DataDome &co. require: paced
 * navigation, consent dismissal, trusted type/click/press, reading scroll,
 * anti-bot detection, and the page's own hydration read. Extends {@link PageEval}:
 * every HumanSession is a PageEval, not the reverse.
 *
 * Implementations live in browser-social (fromCamofoxSession, humanFromPageEval).
 */
export interface HumanSession extends PageEval {
  /** Navigate paced by the session's read-pacer, then assert not blocked. */
  gotoPaced(url: string): Promise<void>
  /** Human reading scroll — variable bursts with dwells (lazy-load trigger). */
  scroll(times?: number): Promise<void>
  /** Dismiss a cookie/consent banner if present (first matching selector wins). */
  acceptConsent(selectors: string[]): Promise<boolean>
  /** Glide to a field, click, type char-by-char with jittered keystrokes. */
  type(selector: string, text: string, opts?: { delay?: number }): Promise<void>
  /** Real mouse move-to-element + click. */
  click(selector: string): Promise<void>
  /** Press a keyboard key (e.g. "Enter"). */
  press(key: string): Promise<void>
  /** True if the current page is an anti-bot challenge / interstitial. */
  isBlocked(): Promise<boolean>
  /**
   * Read the page's own `__NEXT_DATA__` hydration. `extractor` is an in-page
   * expression receiving the parsed object and returning your slice.
   */
  readNextData<T = unknown>(extractor: string): Promise<T>
  /**
   * Capture the current view as an encoded image. Optional: present on
   * camofox/CDP sessions, absent on eval-only bridges — callers degrade when
   * it is missing rather than getting a broken frame.
   */
  screenshot?(opts?: {
    format?: "png" | "jpeg"
    quality?: number
  }): Promise<{ imageBase64: string; mimeType: string }>
}

/**
 * Runtime guard: does this PageEval also provide the trusted-input
 * {@link HumanSession} surface (real click/type/press)?
 */
export function isHumanSession(p: PageEval): p is HumanSession {
  return "click" in p && "type" in p && "isBlocked" in p
}
