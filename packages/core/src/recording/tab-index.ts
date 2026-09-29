/**
 * In-process cache: tabId → active recording binding.
 *
 * The recording lifecycle splits across multiple tool calls
 * (`browser_open` → N × `browser_step` → `browser_close`). Originally the
 * agent threaded `recordingId` and `recordingStartedAt` through every
 * step — and forgot on long runs, producing the "always 2 frames" bug.
 *
 * Now: `browser_open` writes a binding here, `browser_step`/`browser_close`
 * read it back via `tabId` alone. The agent stops threading state.
 *
 * Cold-start fallback: if the cache misses (process restart, multi-instance
 * scaling), the caller falls through to
 * `recordingService.findActiveByTabId(userId, tabId)` and re-populates.
 *
 * In-process state is fine here — the binding is per-physical-instance
 * anyway (each Cloud Run revision serves its own tabs), and the DB is
 * the source of truth on miss.
 */

export interface TabBinding {
  recordingId: string
  recordingStartedAt: Date
  userId: string
  /** Next monotonic frame index — incremented atomically per capture. */
  nextFrameIndex: number
}

const bindings = new Map<string, TabBinding>()

/** Set or replace the binding for a tab. Called by `browser_open`. */
export function setTabBinding(tabId: string, binding: TabBinding): void {
  bindings.set(tabId, { ...binding })
}

/** Read the binding for a tab. Returns undefined on cache miss. */
export function getTabBinding(tabId: string): TabBinding | undefined {
  return bindings.get(tabId)
}

/** Drop the binding. Called by `browser_close`. */
export function clearTabBinding(tabId: string): void {
  bindings.delete(tabId)
}

/**
 * Atomically increment `nextFrameIndex` and return the previous value.
 * Single-threaded Node loop makes this a simple read-then-write.
 */
export function nextFrameIndex(tabId: string): number | undefined {
  const binding = bindings.get(tabId)
  if (!binding) return undefined
  const idx = binding.nextFrameIndex
  binding.nextFrameIndex = idx + 1
  return idx
}

/** Test/diagnostic helper — wipe all bindings. */
export function clearAllTabBindings(): void {
  bindings.clear()
}

/** Test/diagnostic helper — count of live bindings. */
export function tabBindingCount(): number {
  return bindings.size
}
