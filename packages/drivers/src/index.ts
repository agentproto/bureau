/**
 * @agentproto/bureau-drivers
 *
 * Concrete BrowserDriver backends on the @agentproto/bureau-core port, plus a
 * registry the MCP server and scrape router resolve through. Backends register
 * a BrowserDriverProvider descriptor under their `kind`; callers dispatch by
 * kind or by capability — never via an `if (kind === …)` switch.
 *
 * Per-backend implementations are subpath exports:
 *   @agentproto/bureau-drivers/chromium · /camofox · /stagehand · /browserbase · /mcp
 * (extension + headless live in @agentproto/bureau-core/driver already.)
 */

import type {
  BrowserDriverKind,
  BrowserDriverProvider,
} from "@agentproto/bureau-core/driver"

export interface BrowserDriverRegistry {
  /** Register a backend under its `kind`. Last registration for a kind wins. */
  register(provider: BrowserDriverProvider): void
  /** Resolve the provider for a kind. */
  get(kind: BrowserDriverKind): BrowserDriverProvider | undefined
  /** All registered providers, registration order. */
  list(): BrowserDriverProvider[]
  /** First provider whose descriptor satisfies the predicate (capability-based dispatch). */
  find(
    predicate: (provider: BrowserDriverProvider) => boolean
  ): BrowserDriverProvider | undefined
}

export function createBrowserDriverRegistry(): BrowserDriverRegistry {
  const byKind = new Map<BrowserDriverKind, BrowserDriverProvider>()
  const order: BrowserDriverProvider[] = []
  return {
    register(provider) {
      if (!byKind.has(provider.kind)) order.push(provider)
      byKind.set(provider.kind, provider)
    },
    get(kind) {
      return byKind.get(kind)
    },
    list() {
      return [...order]
    },
    find(predicate) {
      return order.find(predicate)
    },
  }
}
