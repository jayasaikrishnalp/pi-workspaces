/**
 * Vitest: useChatStream — history hydration.
 *
 * Spec:
 *   - When sessionKey resolves, the hook GETs /api/sessions/{key}/messages
 *   - The returned messages array is dropped into reducer state as-is
 *     (no streaming replay; no per-event dispatch); .streaming stays false
 *   - Subsequent send() events still compose normally on top of hydrated history
 *   - 404 is non-fatal: leave messages empty, do not surface as error
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  withCredentials: boolean
  listeners: Map<string, Array<(ev: MessageEvent) => void>> = new Map()
  closed = false
  readyState = 1
  CONNECTING = 0; OPEN = 1; CLOSED = 2
  onmessage: null = null
  onerror: null = null
  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url
    this.withCredentials = !!init?.withCredentials
    MockEventSource.instances.push(this)
  }
  addEventListener(name: string, fn: (ev: MessageEvent) => void) {
    const arr = this.listeners.get(name) ?? []
    arr.push(fn)
    this.listeners.set(name, arr)
  }
  removeEventListener(name: string, fn: (ev: MessageEvent) => void) {
    const arr = this.listeners.get(name) ?? []
    this.listeners.set(name, arr.filter((f) => f !== fn))
  }
  close() { this.closed = true }
  fire(eventName: string, payload: unknown) {
    const ev = { data: JSON.stringify(payload) } as MessageEvent
    for (const fn of this.listeners.get(eventName) ?? []) fn(ev)
  }
}

beforeEach(() => {
  MockEventSource.instances = []
  ;(globalThis as any).EventSource = MockEventSource
  sessionStorage.clear()
})

afterEach(() => { vi.restoreAllMocks() })

interface SetupOptions {
  hydratedMessages?: unknown[]
  hydrateStatus?: number
}

async function setupHook(opts: SetupOptions = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/sessions' && init?.method === 'POST') {
      return new Response(JSON.stringify({ sessionKey: 'sess-hydrate' }), { status: 201 })
    }
    if (url === '/api/sessions/sess-hydrate/messages' && (!init?.method || init?.method === 'GET')) {
      const status = opts.hydrateStatus ?? 200
      const body = status === 200
        ? JSON.stringify({ messages: opts.hydratedMessages ?? [] })
        : JSON.stringify({ error: { code: 'UNKNOWN_SESSION', message: '404' } })
      return new Response(body, { status })
    }
    if (url === '/api/send-stream' && init?.method === 'POST') {
      return new Response(JSON.stringify({ runId: 'run-hydrate' }), { status: 202 })
    }
    return new Response('not found', { status: 404 })
  })
  ;(globalThis as any).fetch = fetchMock

  const { useChatStream } = await import('../../src/hooks/useChatStream')
  const r = renderHook(() => useChatStream())
  await waitFor(() => expect(r.result.current.sessionKey).toBe('sess-hydrate'))
  await waitFor(() => expect(MockEventSource.instances.length).toBe(1))
  return { ...r, fetchMock, es: () => MockEventSource.instances[0] }
}

describe('useChatStream — history hydration', () => {
  it('GETs /api/sessions/:key/messages once sessionKey lands', async () => {
    const { fetchMock } = await setupHook()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/sessions/sess-hydrate/messages',
        expect.any(Object),
      )
    })
  })

  it('drops hydrated messages straight into state (no streaming flag)', async () => {
    const hydrated = [
      { id: 'u1', role: 'user', text: 'hello',
        toolCalls: [], streaming: false, createdAt: 1 },
      { id: 'a1', role: 'assistant', text: 'hi there',
        toolCalls: [], streaming: false, createdAt: 2, usage: '↓ 5 ↑ 3' },
    ]
    const { result } = await setupHook({ hydratedMessages: hydrated })
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    expect(result.current.messages[0].role).toBe('user')
    expect(result.current.messages[0].text).toBe('hello')
    expect(result.current.messages[1].role).toBe('assistant')
    expect(result.current.messages[1].text).toBe('hi there')
    // No phantom streaming after hydrate.
    expect(result.current.streaming).toBe(false)
  })

  it('404 on hydrate is silent — empty messages, no error surfaced', async () => {
    const { result } = await setupHook({ hydrateStatus: 404 })
    // Wait for the hydrate fetch to settle.
    await new Promise((r) => setTimeout(r, 30))
    expect(result.current.messages).toHaveLength(0)
    expect(result.current.error).toBeNull()
  })

  it('subsequent send() still composes on top of hydrated history', async () => {
    const hydrated = [
      { id: 'u1', role: 'user', text: 'old prompt',
        toolCalls: [], streaming: false, createdAt: 1 },
      { id: 'a1', role: 'assistant', text: 'old reply',
        toolCalls: [], streaming: false, createdAt: 2 },
    ]
    const { result, es } = await setupHook({ hydratedMessages: hydrated })
    await waitFor(() => expect(result.current.messages).toHaveLength(2))

    await act(async () => { await result.current.send('next prompt') })
    // User message appended (history preserved + new user msg)
    expect(result.current.messages.length).toBe(3)
    expect(result.current.messages[2].role).toBe('user')
    expect(result.current.messages[2].text).toBe('next prompt')

    // Streamed assistant reply
    act(() => {
      es().fire('assistant.start', { event: 'assistant.start', data: { messageId: 'a2' } })
      es().fire('assistant.delta', { event: 'assistant.delta', data: { messageId: 'a2', delta: 'streaming' } })
      es().fire('assistant.completed', { event: 'assistant.completed', data: { messageId: 'a2', text: 'streaming' } })
      es().fire('pi.run.completed', { event: 'pi.run.completed', data: {} })
    })
    await waitFor(() => expect(result.current.messages).toHaveLength(4))
    expect(result.current.messages[3].text).toBe('streaming')
    expect(result.current.streaming).toBe(false)
  })
})
