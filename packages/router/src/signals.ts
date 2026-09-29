import type { EscalationSignal } from "./types"

/** Raw output of a single tier attempt, before the router judges it. */
export interface TierFetch {
  html?: string
  /** Structured data when the tier extracts on its own (AI extract / agent). */
  data?: unknown
  status?: number
  headers?: Record<string, string>
  costUsd?: number
  llmCalls?: number
}

/** Anti-bot vendor fingerprints that appear in challenge-page bodies. */
const BLOCK_FINGERPRINTS: RegExp[] = [
  /cf-browser-verification|cf-challenge|\/cdn-cgi\/|just a moment\.\.\./i, // cloudflare
  /_incapsula_|incap_ses_|x-iinfo/i, // imperva/incapsula
  /perimeterx|_px(2|3)?=|px-captcha/i, // perimeterx
  /datadome|dd_cookie|x-datadome/i, // datadome
  /ak_bmsc|akamai|reference #\d+\.\w+/i, // akamai
  /attention required|access denied|are you a robot/i, // generic challenge copy
]

const BLOCKED_STATUSES = new Set([401, 403, 407, 429, 503])

/** Below this many visible chars, treat the body as empty. Kept low — a real
 * minimal page (e.g. example.com ≈ 130 chars) is NOT empty; only a near-blank
 * shell (cookie wall stripped, JS-only body) should trip this. */
const EMPTY_BODY_CHARS = 32

/** A script-byte-to-text-byte ratio above this signals an unrendered SPA shell. */
const SPA_SCRIPT_RATIO = 8

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
const TAG = /<[^>]+>/g

/** Data scripts (ld+json, embedded JSON state) are PAYLOAD, not SPA shell
 *  code — counting their bytes toward the script ratio falsely flags
 *  data-rich server-rendered pages as unrendered shells. */
const DATA_SCRIPT_TYPE = /type\s*=\s*["']?application\/(ld\+json|json)["']?/i

/** Strip tags and collapse whitespace to estimate visible text length. */
function visibleTextLength(html: string): number {
  return html
    .replace(SCRIPT_TAG, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(TAG, " ")
    .replace(/\s+/g, " ")
    .trim().length
}

function scriptByteLength(html: string): number {
  let total = 0
  for (const m of html.matchAll(SCRIPT_TAG)) {
    const attrs = m[1] ?? ""
    if (DATA_SCRIPT_TYPE.test(attrs)) continue // ld+json / embedded JSON is data
    total += m[2]?.length ?? 0
  }
  return total
}

/**
 * Inspect a tier's raw output and report every reason it justifies escalation.
 * `missingFields` is supplied by the extractor after it ran against the body.
 */
export function detectSignals(
  fetch: TierFetch,
  opts: { missingFields?: string[] } = {}
): EscalationSignal[] {
  const signals: EscalationSignal[] = []
  const { status, headers, html } = fetch

  if (status !== undefined && BLOCKED_STATUSES.has(status))
    signals.push("blocked")

  const headerBlob = headers
    ? Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
    : ""
  const probe = `${headerBlob}\n${html ?? ""}`
  if (
    !signals.includes("blocked") &&
    BLOCK_FINGERPRINTS.some(re => re.test(probe))
  ) {
    signals.push("blocked")
  }

  if (html !== undefined) {
    const textLen = visibleTextLength(html)
    if (textLen < EMPTY_BODY_CHARS) {
      signals.push("empty_body")
    } else {
      const scriptLen = scriptByteLength(html)
      if (textLen > 0 && scriptLen / textLen > SPA_SCRIPT_RATIO)
        signals.push("spa_shell")
    }
  }

  if (opts.missingFields && opts.missingFields.length > 0)
    signals.push("missing_field")

  return signals
}

/** A signal is "hard" when it means this tier cannot satisfy the request at all. */
export function hasBlockingSignal(signals: EscalationSignal[]): boolean {
  return signals.some(
    s =>
      s === "blocked" ||
      s === "empty_body" ||
      s === "spa_shell" ||
      s === "missing_field"
  )
}
