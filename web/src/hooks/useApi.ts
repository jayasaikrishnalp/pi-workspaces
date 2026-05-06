import { useCallback, useEffect, useState } from 'react'

import { ApiError } from '../lib/api'

export interface UseApiState<T> {
  data: T | null
  error: Error | null
  loading: boolean
  reload: () => void
  unauthorized: boolean
}

/**
 * Tiny fetch hook. No SWR, no react-query — this scope doesn't need either.
 * Re-runs when `key` changes; `reload()` increments an internal counter.
 *
 * Detects 401 (cookie expired / never logged in) so callers can show the
 * login prompt without raising.
 */
export function useApi<T>(key: unknown, fn: () => Promise<T>): UseApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(false)
  const [unauthorized, setUnauthorized] = useState(false)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    // Per-effect cancellation — a shared ref would be reset by the next
    // effect run before the prior fetch resolves, letting stale data
    // overwrite fresh data when `key` changes mid-flight (S1).
    let cancelled = false
    setLoading(true)
    fn()
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError(null)
        setUnauthorized(false)
      })
      .catch((e: Error) => {
        if (cancelled) return
        if (e instanceof ApiError && e.status === 401) {
          setUnauthorized(true)
          setError(null)
        } else {
          setError(e)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])

  return { data, error, loading, reload, unauthorized }
}
