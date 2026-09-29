/**
 * `cachedBureauRuntime` — a per-tenant lifecycle cache over any BureauRuntime,
 * expressed as a BureauRuntime itself (a decorator, so it composes anywhere the
 * port is consumed).
 *
 * Why it exists: an EPHEMERAL Bureau (a per-call e2b sandbox) has no natural
 * cache — unlike a persistent workstation, whose host resolver already caches +
 * single-flights. Without this, a consumer that re-provisions per operation (the
 * browser driver re-provisions on every tool call) would spin up a FRESH sandbox
 * each time: no session continuity within a turn, and a cost blow-up. This wraps
 * the raw adapter so repeated `provision({tenantId})` within a window reuse one
 * Bureau.
 *
 * Three jobs the raw adapter can't do alone (mirrors the prior binding store):
 *   • single-flight — concurrent provisions for one tenant share ONE backend
 *     provision instead of racing up N sandboxes.
 *   • expiry — the backend reaps an idle Bureau at its own timeout; an entry past
 *     its (margin-adjusted) deadline is a miss and re-provisions, so we never
 *     hand back a host the provider is about to kill out from under us.
 *   • invalidation — `stop()` on a handed-out handle drops the cache entry AND
 *     stops the backend, so the next provision starts clean (callers stop() only
 *     to discard a dead host after a failed dispatch).
 *
 * Vendor-neutral: it only drives the injected inner runtime, so e2b (cloud) and
 * any other adapter flow through the same cache.
 */

import type {
  BureauRuntime,
  BureauProvisionInput,
  ProvisionedBureau,
} from "./endpoint.js"

/** Reap the local entry this long BEFORE the backend's own timeout, so we never
 *  reuse a host the provider is about to kill. */
const EXPIRY_MARGIN_MS = 30_000
/** Fallback TTL when neither the input nor opts give a timeout (matches the e2b
 *  adapter's own 15-minute default). */
const DEFAULT_TTL_MS = 15 * 60_000

export interface CachedBureauRuntimeOptions {
  /**
   * How long a provisioned Bureau is reused before re-provisioning. Defaults to
   * `provision.timeoutMs` (then 15min). The effective deadline subtracts a 30s
   * margin so we evict just before the backend reaps the sandbox.
   */
  ttlMs?: number
}

interface CacheEntry {
  readonly bureau: ProvisionedBureau
  /** `Date.now()` past which the entry is treated as dead and re-provisioned. */
  readonly expiresAt: number
}

/**
 * Wrap a runtime with per-tenant caching + single-flight. Keyed by `tenantId`;
 * `env`/`timeoutMs` from the FIRST provision in a window are the ones used until
 * the entry expires or is stopped.
 */
export function cachedBureauRuntime(
  inner: BureauRuntime,
  opts: CachedBureauRuntimeOptions = {}
): BureauRuntime {
  const live = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<ProvisionedBureau>>()

  /** Drop a tenant's entry and stop its backend Bureau (best-effort). */
  async function evict(
    tenantId: string,
    bureau: ProvisionedBureau
  ): Promise<void> {
    if (live.get(tenantId)?.bureau === bureau) live.delete(tenantId)
    await bureau.stop().catch(() => undefined)
  }

  /** A handle that shares the cached Bureau but whose stop() invalidates it. */
  function handle(
    tenantId: string,
    bureau: ProvisionedBureau
  ): ProvisionedBureau {
    return {
      id: bureau.id,
      endpoint: bureau.endpoint,
      stop: () => evict(tenantId, bureau),
      ...(bureau.pause ? { pause: bureau.pause.bind(bureau) } : {}),
      ...(bureau.resume ? { resume: bureau.resume.bind(bureau) } : {}),
    }
  }

  async function provision(
    input: BureauProvisionInput
  ): Promise<ProvisionedBureau> {
    const bureau = await inner.provision(input)
    const ttl = opts.ttlMs ?? input.timeoutMs ?? DEFAULT_TTL_MS
    live.set(input.tenantId, {
      bureau,
      expiresAt: Date.now() + Math.max(0, ttl - EXPIRY_MARGIN_MS),
    })
    return bureau
  }

  return {
    kind: inner.kind,
    async provision(input) {
      const existing = live.get(input.tenantId)
      if (existing) {
        if (existing.expiresAt > Date.now()) {
          return handle(input.tenantId, existing.bureau)
        }
        // Stale entry — best-effort reap the old sandbox before replacing it.
        void evict(input.tenantId, existing.bureau)
      }

      const pending = inflight.get(input.tenantId)
      if (pending) return pending.then(b => handle(input.tenantId, b))

      const job = provision(input).finally(() =>
        inflight.delete(input.tenantId)
      )
      inflight.set(input.tenantId, job)
      return job.then(b => handle(input.tenantId, b))
    },
  }
}
