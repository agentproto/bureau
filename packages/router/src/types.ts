/**
 * Tiered scrape router — escalates across backends on real failure signals
 * rather than a boot-fixed provider choice.
 */

/** Escalation tiers, ordered cheapest → most capable. */
export enum Tier {
  HTTP = 0,
  HTTP_SESSIONED = 1,
  BROWSER = 2,
  BROWSER_STEALTH = 3,
  AGENT = 4,
}

/** Caps that bound how far the router is allowed to escalate. */
export interface Budget {
  maxTier: Tier
  maxLlmCalls: number
  maxCostUsd: number
  /** Wall-clock deadline for a single tier attempt (fetch + extract). A tier
   *  that exceeds it is recorded as an error and the router escalates. */
  perTierTimeoutMs: number
}

/** Reasons that justify escalating to the next tier. */
export type EscalationSignal =
  | "blocked" // 403 / 429 / 503 / cloudflare / akamai / perimeterx / datadome
  | "empty_body"
  | "spa_shell" // high script-to-text ratio, no rendered content
  | "missing_field" // requested schema field absent after extraction

export interface ScrapeRequest {
  schema?: unknown
  budget?: Partial<Budget>
  /** Entry hint reusing the existing per-domain profile routing. */
  profileHint?: string
}

/** One escalation step, recorded for observability and replay. */
export interface TierTrace {
  tier: Tier
  signals: EscalationSignal[]
  costUsd: number
  llmCalls: number
  error?: string
}

export interface ScrapeResult {
  url: string
  tierUsed: Tier
  html?: string
  data?: unknown
  signals: EscalationSignal[]
  costUsd: number
  llmCalls: number
  /** Full escalation path taken to reach the result. */
  trace: TierTrace[]
}

export interface TieredScrapeRouter {
  scrape(url: string, req?: ScrapeRequest): Promise<ScrapeResult>
}

export const DEFAULT_BUDGET: Budget = {
  maxTier: Tier.BROWSER,
  maxLlmCalls: 4,
  maxCostUsd: 0.1,
  perTierTimeoutMs: 30_000,
}
