import { describe, expect, it } from "vitest"
import { createTieredScrapeRouter, type ExtractorPort } from "./router"
import type { TierExecutor } from "./tier"
import { Tier, type ScrapeResult } from "./types"

/** A scripted tier that returns a fixed fetch (or throws). */
function fakeTier(
  tier: Tier,
  out: { html?: string; data?: unknown; status?: number; throws?: boolean }
): TierExecutor & { calls: number } {
  const t = {
    tier,
    label: `t${tier}`,
    calls: 0,
    async run() {
      t.calls++
      if (out.throws) throw new Error(`tier ${tier} boom`)
      return { html: out.html, data: out.data, status: out.status }
    },
  }
  return t
}

const GOOD_HTML = `<html><body>${"word ".repeat(100)}</body></html>`
const CF_HTML = `<html><body>Just a moment...<div id="cf-challenge"></div></body></html>`

describe("TieredScrapeRouter", () => {
  it("stops at T0 when HTTP succeeds", async () => {
    const t0 = fakeTier(Tier.HTTP, { html: GOOD_HTML, status: 200 })
    const t2 = fakeTier(Tier.BROWSER, { html: GOOD_HTML })
    const router = createTieredScrapeRouter({ tiers: [t0, t2] })

    const r = await router.scrape("https://example.com")
    expect(r.tierUsed).toBe(Tier.HTTP)
    expect(t0.calls).toBe(1)
    expect(t2.calls).toBe(0)
  })

  it("escalates past a cloudflare block", async () => {
    const t0 = fakeTier(Tier.HTTP, { html: CF_HTML, status: 403 })
    const t2 = fakeTier(Tier.BROWSER, { html: GOOD_HTML })
    const router = createTieredScrapeRouter({
      tiers: [t0, t2],
      defaultBudget: { maxTier: Tier.BROWSER, maxLlmCalls: 4, maxCostUsd: 1 },
    })

    const r = await router.scrape("https://blocked.com")
    expect(r.tierUsed).toBe(Tier.BROWSER)
    expect(t0.calls).toBe(1)
    expect(t2.calls).toBe(1)
    expect(r.trace[0]?.signals).toContain("blocked")
  })

  it("escalates past an empty body", async () => {
    const t0 = fakeTier(Tier.HTTP, {
      html: "<html><body></body></html>",
      status: 200,
    })
    const t2 = fakeTier(Tier.BROWSER, { html: GOOD_HTML })
    const router = createTieredScrapeRouter({ tiers: [t0, t2] })

    const r = await router.scrape("https://spa.com")
    expect(r.tierUsed).toBe(Tier.BROWSER)
    expect(r.trace[0]?.signals).toContain("empty_body")
  })

  it("escalates when a thrown tier hard-misses", async () => {
    const t0 = fakeTier(Tier.HTTP, { throws: true })
    const t2 = fakeTier(Tier.BROWSER, { html: GOOD_HTML })
    const router = createTieredScrapeRouter({ tiers: [t0, t2] })

    const r = await router.scrape("https://flaky.com")
    expect(r.tierUsed).toBe(Tier.BROWSER)
    expect(r.trace[0]?.error).toContain("boom")
  })

  it("escalates on missing schema field via the extractor", async () => {
    const t0 = fakeTier(Tier.HTTP, { html: GOOD_HTML, status: 200 })
    const t2 = fakeTier(Tier.BROWSER, { html: GOOD_HTML })
    const extractor: ExtractorPort = {
      async extract(_html, _schema, _host) {
        // T0 misses the field; the second invocation (T2) finds it.
        if (extractor.__seen)
          return { data: { price: 42 }, missingFields: [], llmCalls: 1 }
        extractor.__seen = true
        return { data: {}, missingFields: ["price"], llmCalls: 1 }
      },
    } as ExtractorPort & { __seen?: boolean }
    const router = createTieredScrapeRouter({
      tiers: [t0, t2],
      extractor,
      defaultBudget: { maxTier: Tier.BROWSER, maxLlmCalls: 10, maxCostUsd: 1 },
    })

    const r = await router.scrape("https://store.com", {
      schema: { price: "number" },
    })
    expect(r.tierUsed).toBe(Tier.BROWSER)
    expect((r.data as { price: number }).price).toBe(42)
  })

  it("respects maxTier budget and returns the best attempt", async () => {
    const t0 = fakeTier(Tier.HTTP, { html: CF_HTML, status: 403 })
    const t2 = fakeTier(Tier.BROWSER, { html: GOOD_HTML })
    const router = createTieredScrapeRouter({
      tiers: [t0, t2],
      defaultBudget: { maxTier: Tier.HTTP, maxLlmCalls: 4, maxCostUsd: 1 },
    })

    const r: ScrapeResult = await router.scrape("https://blocked.com")
    expect(r.tierUsed).toBe(Tier.HTTP) // never allowed to escalate
    expect(t2.calls).toBe(0)
    expect(r.signals).toContain("blocked")
  })
})
