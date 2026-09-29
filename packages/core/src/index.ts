/**
 * @agentproto/bureau-core
 *
 * Shared browsing-state primitives:
 * - session/ — cookie + localStorage snapshots synced by the browser extension
 * - recording/ — playable agent run captures (screenshots, rrweb, etc.)
 * - driver/ — live CDP-shaped control (extension + headless backends)
 */

export * from "./session/index.js"
export * from "./recording/index.js"
// driver/ is exposed as a subpath only (@agentproto/bureau-core/driver) to keep
// Playwright as an optional peer dep — root import stays Node-pure.
//
// DB persistence (recording/session base-columns, services, provider factories)
// is NOT here — it lives in a separate store adapter. This package
// stays vendor-neutral: no drizzle, no postgres, no crypto.
