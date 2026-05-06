import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import { reduce, INITIAL_CHAT_STATE, appendUserMessage, hydrate, type ChatMessage, type ChatState } from '../lib/streamingMessage'
import { subscribeNamedEvents, CHAT_EVENT_NAMES } from '../lib/sse'

interface ServerEvent {
  event: string
  data: Record<string, unknown>
  meta?: { runId?: string; sessionKey?: string; seq?: number; eventId?: string }
}

type ChatAction =
  | { kind: 'event'; event: ServerEvent }
  | { kind: 'user'; text: string }
  | { kind: 'hydrate'; messages: ChatMessage[] }
  | { kind: 'reset' }

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case 'event':   return reduce(state, action.event)
    case 'user':    return appendUserMessage(state, action.text)
    case 'hydrate': return hydrate(state, action.messages)
    case 'reset':   return INITIAL_CHAT_STATE
  }
}

interface SessionResp { sessionKey: string }

/**
 * Manages a chat session: ensures one exists, opens an SSE subscription
 * to /api/chat-events?sessionKey=..., reduces incoming events, exposes
 * `messages`, `streaming`, `error`, and a `send(text)` action.
 */
export function useChatStream() {
  const [state, dispatch] = useReducer(chatReducer, INITIAL_CHAT_STATE)
  const [sessionKey, setSessionKey] = useState<string | null>(null)
  const [currentRunId, setCurrentRunId] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)

  // Create or reuse a session.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const stored = sessionStorage.getItem('hive.sessionKey')
      if (stored) { if (!cancelled) setSessionKey(stored); return }
      const r = await fetch('/api/sessions', { method: 'POST', credentials: 'same-origin' })
      if (!r.ok) return
      const body = (await r.json()) as SessionResp
      if (cancelled) return
      sessionStorage.setItem('hive.sessionKey', body.sessionKey)
      setSessionKey(body.sessionKey)
    })().catch((err) => console.error('[useChatStream] session bootstrap failed:', err))
    return () => { cancelled = true }
  }, [])

  // Hydrate persisted history once we have a session. Runs alongside SSE; the
  // server returns final ChatMessage shapes (final text + finalized toolCalls)
  // so we don't replay streaming events.
  useEffect(() => {
    if (!sessionKey) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(
          `/api/sessions/${encodeURIComponent(sessionKey)}/messages`,
          { credentials: 'same-origin' },
        )
        if (!r.ok) return // silent: 404 = unknown session, leave state empty
        const body = (await r.json()) as { messages?: ChatMessage[] }
        if (cancelled) return
        if (Array.isArray(body.messages) && body.messages.length > 0) {
          dispatch({ kind: 'hydrate', messages: body.messages })
        }
      } catch (err) {
        console.error('[useChatStream] hydrate failed:', err)
      }
    })()
    return () => { cancelled = true }
  }, [sessionKey])

  // Open SSE once we have a session.
  useEffect(() => {
    if (!sessionKey) return
    const url = `/api/chat-events?sessionKey=${encodeURIComponent(sessionKey)}`
    const es = new EventSource(url, { withCredentials: true })
    esRef.current = es
    const onEvent = (m: MessageEvent) => {
      try {
        const parsed = JSON.parse(m.data) as ServerEvent
        dispatch({ kind: 'event', event: parsed })
        // Clear currentRunId on terminal lifecycle events so the stop button
        // disappears and abort() becomes a no-op until the next send.
        if (
          parsed.event === 'pi.run.completed' ||
          parsed.event === 'pi.run.cancelled' ||
          parsed.event === 'pi.run.failed'
        ) {
          setCurrentRunId(null)
        }
      } catch (err) {
        console.error('[useChatStream] bad event payload:', err)
      }
    }
    // The backend writes `event: <name>` lines (see src/server/http-helpers.ts
    // sseWrite + src/routes/chat-events.ts), so the default 'message' handler
    // alone misses every frame. Subscribe to every known name PLUS 'message'.
    const unsub = subscribeNamedEvents(es, CHAT_EVENT_NAMES, onEvent)
    es.addEventListener('error', () => { /* EventSource auto-reconnects. */ })
    return () => { unsub(); es.close(); esRef.current = null }
  }, [sessionKey])

  const send = useCallback(async (text: string) => {
    if (!sessionKey) throw new Error('session not ready')
    if (!text.trim()) return
    dispatch({ kind: 'user', text })
    const r = await fetch('/api/send-stream', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey, message: text }),
    })
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: { message?: string } }
      dispatch({ kind: 'event', event: { event: 'pi.error', data: { message: body.error?.message ?? `send failed (${r.status})` } } })
      return
    }
    // Capture the runId so we can abort it.
    const body = await r.json().catch(() => ({})) as { runId?: string }
    if (typeof body.runId === 'string' && body.runId.length > 0) {
      setCurrentRunId(body.runId)
    }
  }, [sessionKey])

  const abort = useCallback(async () => {
    if (!currentRunId) return
    try {
      await fetch(`/api/runs/${encodeURIComponent(currentRunId)}/abort`, {
        method: 'POST',
        credentials: 'same-origin',
      })
    } catch (err) {
      console.error('[useChatStream] abort failed:', err)
    }
  }, [currentRunId])

  const reset = useCallback(() => dispatch({ kind: 'reset' }), [])

  /** Switch to an existing session. Resets state; the hydrate effect refills it. */
  const switchSession = useCallback((nextKey: string) => {
    if (!nextKey || nextKey === sessionKey) return
    dispatch({ kind: 'reset' })
    setCurrentRunId(null)
    sessionStorage.setItem('hive.sessionKey', nextKey)
    setSessionKey(nextKey)
  }, [sessionKey])

  /** Create a fresh session and switch to it. */
  const newSession = useCallback(async () => {
    try {
      const r = await fetch('/api/sessions', { method: 'POST', credentials: 'same-origin' })
      if (!r.ok) return
      const body = (await r.json()) as SessionResp
      switchSession(body.sessionKey)
    } catch (err) {
      console.error('[useChatStream] newSession failed:', err)
    }
  }, [switchSession])

  return {
    ...state, sessionKey, currentRunId,
    send, abort, reset, switchSession, newSession,
  }
}
