import type { TierExecutor } from "./tier"
import { Tier } from "./types"

/**
 * A scrape backend = a tier executor that self-describes its capabilities and
 * cost, so the registry can pick eligible backends under a budget instead of
 * the caller hand-ordering a `tiers` array. Our own backends (http, headless,
 * camofox) are free; managed externals (firecrawl, browserbase, zyte) cost $
 * per call and are gated on config availability + the budget's cost ceiling.
 */
export interface ScrapeBackendDescriptor {
  /** Stable id used by `engine` overrides (e.g. "firecrawl"). */
  id: string
  /** Escalation rung — drives ordering. */
  tier: Tier
  /** Executes JS / renders SPA content. */
  rendersJs: boolean
  /** Defeats anti-bot challenges (cloudflare/akamai/…). */
  handlesAntibot: boolean
  /** Stealth fingerprinting (Camofox, managed stealth). */
  stealth: boolean
  /** Rough USD per call. 0 for our own backends. */
  costPerCallUsd: number
  /** Configured + usable (e.g. API key present). Unavailable backends are skipped. */
  available: boolean
}

export interface ScrapeBackend extends TierExecutor {
  readonly descriptor: ScrapeBackendDescriptor
}

export interface ScrapeBackendRegistry {
  register(backend: ScrapeBackend): void
  get(id: string): ScrapeBackend | undefined
  list(): ScrapeBackend[]
  /**
   * Available backends within the tier + per-call-cost caps, cheapest-tier
   * first then cheapest-cost. This is the `tiers` array the router escalates
   * through — managed/costly backends sit at the back, gated by budget.
   */
  eligible(caps: { maxTier: Tier; maxCostUsd: number }): ScrapeBackend[]
}

export function createScrapeBackendRegistry(): ScrapeBackendRegistry {
  const byId = new Map<string, ScrapeBackend>()
  return {
    register(backend) {
      byId.set(backend.descriptor.id, backend)
    },
    get(id) {
      return byId.get(id)
    },
    list() {
      return [...byId.values()]
    },
    eligible({ maxTier, maxCostUsd }) {
      return [...byId.values()]
        .filter(b => b.descriptor.available)
        .filter(b => b.descriptor.tier <= maxTier)
        .filter(b => b.descriptor.costPerCallUsd <= maxCostUsd)
        .sort(
          (a, b) =>
            a.descriptor.tier - b.descriptor.tier ||
            a.descriptor.costPerCallUsd - b.descriptor.costPerCallUsd
        )
    },
  }
}

/** Wrap a plain TierExecutor with a descriptor to register it as a backend. */
export function asScrapeBackend(
  executor: TierExecutor,
  descriptor: Omit<ScrapeBackendDescriptor, "tier"> & { tier?: Tier }
): ScrapeBackend {
  return {
    ...executor,
    descriptor: { ...descriptor, tier: descriptor.tier ?? executor.tier },
  }
}

export { Tier }
