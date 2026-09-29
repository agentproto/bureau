/**
 * BureauRuntime adapter registry — the swappable seam, vendor-neutral.
 *
 * Adapters register by `kind`; callers resolve by scope, never by `if (kind ===
 * …)`. Kinds are OPEN and app-declared: each host app names its own adapter
 * (a hosted workstation, a standalone Bureau Cloud's "e2b", …) and the
 * registry never enumerates a closed set. Dispatch decides cloud-vs-tunnel by
 * registry MEMBERSHIP — an unregistered kind falls through to the tunnel.
 *
 * This lives in the vendor-neutral SDK (not in any app package) precisely so a
 * SECOND app can declare and resolve its own kind without importing another
 * app's package. Adapters are INJECTED at app startup — there is no default
 * registration here (a package cannot reach an app's live resolver). Mirrors the
 * egress / profile-registry pattern used elsewhere in the codebase.
 */

import type { BureauRuntime } from "./endpoint.js"

const adapters = new Map<string, BureauRuntime>()

/** Register (or replace) the adapter for a kind. */
export function registerBureauRuntime(runtime: BureauRuntime): void {
  adapters.set(runtime.kind, runtime)
}

/** Resolve the adapter for a kind; null when none is registered. */
export function resolveBureauRuntime(kind: string): BureauRuntime | null {
  return adapters.get(kind) ?? null
}

/** Kinds with a registered adapter (diagnostics / capability listing). */
export function listBureauRuntimeKinds(): string[] {
  return [...adapters.keys()]
}
