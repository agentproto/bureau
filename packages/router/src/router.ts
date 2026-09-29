import { detectSignals, hasBlockingSignal, type TierFetch } from "./signals"
import type { TierExecutor } from "./tier"
import {
  DEFAULT_BUDGET,
  Tier,
  type Budget,
  type ScrapeRequest,
  type ScrapeResult,
  type TierTrace,
  type TieredScrapeRouter,
} from "./types"

/** Extractor port — implemented by an external extractor, kept local to avoid a hard dep. */
export interface ExtractorPort {
  extract(
    html: string,
    schema: unknown,
    host: string
  ): Promise<{
    data: unknown
    missingFields: string[]
    llmCalls: number
    costUsd?: number
  }>
}

export interface RouterDeps {
  /** Tiers in escalation order. Gaps are allowed (e.g. no T1). */
  tiers: TierExecutor[]
  /** Optional structured extractor, run when the caller passes a schema. */
  extractor?: ExtractorPort
  defaultBudget?: Budget
}

function host(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** The top-level field names a schema requests, mirroring the extractor's
 *  `normalizeSchema`: either an explicit `{ fields }` map or a flat record. */
function requestedFields(schema: unknown): string[] {
  if (!isRecord(schema)) return []
  const fields = schema.fields
  if (isRecord(fields)) return Object.keys(fields)
  return Object.keys(schema)
}

/**
 * Shallow validation of tier-supplied `data` (the agent rung returns structured
 * data directly, bypassing the extractor that would otherwise report missing
 * fields). Returns the requested field names absent or empty in `data`, so the
 * router can raise `missing_field` and escalate rather than declaring garbage a
 * success. A deeper per-field type check is out of scope for this pass.
 */
function shallowMissingFields(data: unknown, schema: unknown): string[] {
  const fields = requestedFields(schema)
  if (fields.length === 0) return []
  if (!isRecord(data)) return fields
  return fields.filter(f => {
    const v = data[f]
    return v === undefined || v === null || v === ""
  })
}

function resolveBudget(
  req: ScrapeRequest | undefined,
  fallback: Budget
): Budget {
  return { ...fallback, ...(req?.budget ?? {}) }
}

class TierTimeoutError extends Error {
  constructor(ms: number) {
    super(`tier exceeded ${ms}ms deadline`)
    this.name = "TierTimeoutError"
  }
}

/** Race a tier operation against a wall-clock deadline. A timeout rejects with
 *  a TierTimeoutError, which the caller records as an escalation-worthy error. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TierTimeoutError(ms)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Run tiers cheapest-first, escalating only when a tier emits a blocking
 * signal (block / empty body / SPA shell / missing schema field) and the
 * budget still permits the next rung. Returns the first satisfactory result,
 * or the best (last) attempt once the budget is spent.
 */
export function createTieredScrapeRouter(deps: RouterDeps): TieredScrapeRouter {
  const tiers = [...deps.tiers].sort((a, b) => a.tier - b.tier)
  const baseBudget = deps.defaultBudget ?? DEFAULT_BUDGET

  return {
    async scrape(url, req) {
      const budget = resolveBudget(req, baseBudget)
      const h = host(url)
      const trace: TierTrace[] = []
      let spentCost = 0
      let spentLlm = 0
      let best: {
        fetch: TierFetch
        tier: Tier
        data?: unknown
        signals: ReturnType<typeof detectSignals>
      } | null = null

      for (const t of tiers) {
        if (t.tier > budget.maxTier) break
        if (spentCost >= budget.maxCostUsd || spentLlm >= budget.maxLlmCalls)
          break

        let fetch: TierFetch
        let data: unknown
        let missingFields: string[] = []
        try {
          fetch = await withTimeout(t.run(url), budget.perTierTimeoutMs)

          spentCost += fetch.costUsd ?? 0
          spentLlm += fetch.llmCalls ?? 0

          // Run the extractor when a schema is requested and the tier gave us HTML.
          data = fetch.data
          if (
            req?.schema &&
            data === undefined &&
            fetch.html &&
            deps.extractor
          ) {
            const ex = await withTimeout(
              deps.extractor.extract(fetch.html, req.schema, h),
              budget.perTierTimeoutMs
            )
            data = ex.data
            missingFields = ex.missingFields
            spentLlm += ex.llmCalls
            spentCost += ex.costUsd ?? 0
          } else if (req?.schema && data !== undefined) {
            // Tier (e.g. the agent rung) returned structured data directly,
            // bypassing the extractor. Validate it against the schema so
            // incomplete data escalates instead of passing as success.
            missingFields = shallowMissingFields(data, req.schema)
          }
        } catch (err) {
          trace.push({
            tier: t.tier,
            signals: [],
            costUsd: 0,
            llmCalls: 0,
            error: err instanceof Error ? err.message : String(err),
          })
          continue // a thrown/timed-out tier is a hard miss — escalate
        }

        const signals = detectSignals(fetch, { missingFields })
        trace.push({
          tier: t.tier,
          signals,
          costUsd: fetch.costUsd ?? 0,
          llmCalls: fetch.llmCalls ?? 0,
        })
        best = { fetch, tier: t.tier, data, signals }

        if (!hasBlockingSignal(signals)) break // satisfied — stop escalating

        // Hard cap: the pre-check only gates BEFORE a tier runs, but a single
        // tier (notably the agent rung) can report arbitrary cost/llmCalls.
        // Once a tier has pushed us at or over budget, stop escalating —
        // returning this tier's (blocked) result as the best attempt rather
        // than letting the next, costlier rung blow the budget unbounded.
        if (spentCost >= budget.maxCostUsd || spentLlm >= budget.maxLlmCalls)
          break
      }

      if (!best) {
        const lastError = trace[trace.length - 1]?.error
        throw new Error(
          `All tiers failed for ${url}${lastError ? `: ${lastError}` : ""}`
        )
      }

      return {
        url,
        tierUsed: best.tier,
        html: best.fetch.html,
        data: best.data,
        signals: best.signals,
        costUsd: spentCost,
        llmCalls: spentLlm,
        trace,
      }
    },
  }
}

export { Tier }
