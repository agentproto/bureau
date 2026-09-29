"use client"

/**
 * React glue for consuming a Bureau. The hook owns the load/error/refresh
 * lifecycle but NOT the fetch: a host passes a `fetchStatus` thunk (hit a route
 * over the tunnel, or a local client's snapshot directly), keeping the SDK free
 * of any host URL or auth scheme. Wrap `fetchStatus` in `useCallback` so its
 * identity is stable — the hook reloads whenever it changes.
 */

import { useCallback, useEffect, useState } from "react"
import type { BureauStatus } from "../schemas.js"

export interface UseBureauResult {
  status: BureauStatus | null
  error: string | null
  loading: boolean
  reload: () => Promise<void>
}

export function useBureau(
  fetchStatus: () => Promise<BureauStatus>
): UseBureauResult {
  const [status, setStatus] = useState<BureauStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setStatus(await fetchStatus())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Bureau")
    } finally {
      setLoading(false)
    }
  }, [fetchStatus])

  useEffect(() => {
    void reload()
  }, [reload])

  return { status, error, loading, reload }
}
