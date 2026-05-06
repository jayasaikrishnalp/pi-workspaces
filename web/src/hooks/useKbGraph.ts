import { useEffect, useRef, useState } from 'react'

import { getKbGraph, type KbGraph } from '../lib/api'
import { subscribeNamedEvents, KB_EVENT_NAMES } from '../lib/sse'

interface KbChangedPayload {
  kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
  skill: string | null
  ts: number
}

export interface KbGraphState {
  data: KbGraph | null
  error: Error | null
  loading: boolean
}

/**
 * Initial GET /api/kb/graph + SSE on /api/kb/events. On any kb.changed
 * event, refetch — the change set is small enough that a refetch is
 * simpler than merging deltas (and the watcher already debounces).
 */
export function useKbGraph(): KbGraphState & { reload: () => void } {
  const [data, setData] = useState<KbGraph | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const refreshTimer = useRef<number | null>(null)

  const reload = () => {
    setLoading(true)
    getKbGraph()
      .then((g) => { setData(g); setError(null) })
      .catch((e: Error) => setError(e))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
    const es = new EventSource('/api/kb/events', { withCredentials: true })
    const onMsg = (m: MessageEvent) => {
      try {
        const evt = JSON.parse(m.data) as KbChangedPayload
        if (evt.kind === 'addDir' || evt.kind === 'unlinkDir') return
        // Coalesce bursts: refetch at most every 250ms.
        if (refreshTimer.current != null) return
        refreshTimer.current = window.setTimeout(() => {
          refreshTimer.current = null
          reload()
        }, 250)
      } catch {
        /* ignore bad payloads */
      }
    }
    // Backend writes `event: kb.changed` (and heartbeat) lines — subscribe
    // by name plus 'message' so the hook works against real EventSource AND
    // any test stubs that omit the event field.
    const unsub = subscribeNamedEvents(es, KB_EVENT_NAMES, onMsg)
    return () => {
      unsub()
      es.close()
      if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current)
      refreshTimer.current = null
    }
  }, [])

  return { data, error, loading, reload }
}
