import type { TierFetch } from "./signals"
import { Tier } from "./types"

/** A single rung of the escalation ladder. Stateless across calls. */
export interface TierExecutor {
  readonly tier: Tier
  readonly label: string
  run(url: string): Promise<TierFetch>
}

/** Minimal contract the HTTP tier needs from the content package. */
export interface HttpFetchPort {
  fetch(
    url: string,
    options?: Record<string, unknown>
  ): Promise<{
    html?: string
    content?: string
    status?: number
    headers?: Record<string, string>
  }>
}

/**
 * T0 — plain HTTP + cheerio. Cheapest rung; no JS execution. Backed by the
 * content package's scraper (DocumentContentProvider / FetchScraperProvider).
 */
export function httpTier(port: HttpFetchPort): TierExecutor {
  return {
    tier: Tier.HTTP,
    label: "http",
    async run(url) {
      const r = await port.fetch(url)
      return { html: r.html ?? r.content, status: r.status, headers: r.headers }
    },
  }
}

/** The slice of a browser provider the tier needs — satisfied by IBrowserProvider. */
export interface BrowserContentPort {
  createSession(options?: unknown): Promise<{ id: string }>
  navigate(sessionId: string, url: string, options?: unknown): Promise<void>
  getContent(sessionId: string, selector?: string): Promise<{ html: string }>
  closeSession(sessionId: string): Promise<void>
}

/**
 * Wrap a browser provider as a tier: open a session, navigate, read content,
 * always close the session. Used for both Chromium (T2) and Camofox (T3).
 */
export function browserTier(
  provider: BrowserContentPort,
  tier: Tier,
  label: string
): TierExecutor {
  return {
    tier,
    label,
    async run(url) {
      const session = await provider.createSession()
      try {
        await provider.navigate(session.id, url)
        const content = await provider.getContent(session.id)
        return { html: content.html }
      } finally {
        await provider.closeSession(session.id).catch(() => {})
      }
    },
  }
}

/** Minimal contract the AGENT tier needs from the code-as-action package. */
export interface AgentRunPort {
  run(task: {
    url: string
    goal: string
    schema?: unknown
  }): Promise<{ data: unknown; llmCalls: number; fromCache: boolean }>
}

/**
 * T4 — code-as-action agent. The model writes & runs a Playwright script.
 * This rung returns structured `data` directly rather than raw HTML.
 */
export function agentTier(port: AgentRunPort, schema?: unknown): TierExecutor {
  return {
    tier: Tier.AGENT,
    label: "agent",
    async run(url) {
      const goal = schema
        ? "Extract the data matching the requested schema."
        : "Return the fully rendered page content."
      const r = await port.run({ url, goal, schema })
      return { data: r.data, llmCalls: r.llmCalls }
    },
  }
}
