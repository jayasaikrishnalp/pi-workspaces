/**
 * Vitest: useChatStream — abort flow.
 *   - send() captures runId from POST /api/send-stream response into currentRunId
 *   - abort() POSTs /api/runs/{runId}/abort
 *   - currentRunId clears on terminal SSE events (run.completed/failed/cancelled)
 *   - abort is a no-op when there's no active run
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// Stub EventSource before the hook imports it.
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  withCredentials: boolean
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  listeners: Map<string, Array<(ev: MessageEvent) => void>> = new Map()
  closed = false
  readyState = 1
  CONNECTING = 0; OPEN = 1; CLOSED = 2
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
  /** Fire an SSE-named event from the stub. */
  fire(eventName: string, payload: unknown) {
    const ev = { data: JSON.stringify(payload) } as MessageEvent
    for (const fn of this.listeners.get(eventName) ?? []) fn(ev)
  }
}

beforeEach(() => {
  MockEventSource.instances = []
  ;(globalThis as any).EventSource = MockEventSource
  // sessionStorage clean per test
  sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function setupHook() {
  // Mock the session POST and the send POST and the abort POST.
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/sessions' && init?.method === 'POST') {
      return new Response(JSON.stringify({ sessionKey: 'sess-test' }), { status: 201 })
    }
    if (url === '/api/send-stream' && init?.method === 'POST') {
      return new Response(JSON.stringify({ runId: 'run-abc' }), { status: 202 })
    }
    if (/\/api\/runs\/[^/]+\/abort$/.test(url) && init?.method === 'POST') {
      return new Response(JSON.stringify({ cancelled: true }), { status: 202 })
    }
    return new Response('not found', { status: 404 })
  })
  ;(globalThis as any).fetch = fetchMock

  const { useChatStream } = await import('../../src/hooks/useChatStream')
  const r = renderHook(() => useChatStream())
  // Wait until session bootstrap finishes and SSE is open.
  await waitFor(() => expect(r.result.current.sessionKey).toBe('sess-test'))
  await waitFor(() => expect(MockEventSource.instances.length).toBe(1))
  return { ...r, fetchMock, es: () => MockEventSource.instances[0] }
}

describe('useChatStream — abort flow', () => {
  it('exposes currentRunId=null and a no-op abort() when no run is in flight', async () => {
    const { result } = await setupHook()
    expect(result.current.currentRunId).toBeNull()
    expect(typeof result.current.abort).toBe('function')
    // Calling abort with no run does not throw and does not POST.
    await act(async () => { await result.current.abort() })
  })

  it('captures runId from the send-stream response and exposes it', async () => {
    const { result } = await setupHook()
    await act(async () => { await result.current.send('hello') })
    expect(result.current.currentRunId).toBe('run-abc')
  })

  it('abort() POSTs to /api/runs/{runId}/abort', async () => {
    const { result, fetchMock } = await setupHook()
    await act(async () => { await result.current.send('hello') })
    fetchMock.mockClear()
    await act(async () => { await result.current.abort() })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/runs/run-abc/abort',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('clears currentRunId on pi.run.completed', async () => {
    const { result, es } = await setupHook()
    await act(async () => { await result.current.send('hello') })
    expect(result.current.currentRunId).toBe('run-abc')
    act(() => { es().fire('pi.run.completed', { event: 'pi.run.completed', data: {} }) })
    await waitFor(() => expect(result.current.currentRunId).toBeNull())
  })

  it('clears currentRunId on pi.run.cancelled', async () => {
    const { result, es } = await setupHook()
    await act(async () => { await result.current.send('hello') })
    act(() => { es().fire('pi.run.cancelled', { event: 'pi.run.cancelled', data: {} }) })
    await waitFor(() => expect(result.current.currentRunId).toBeNull())
  })

  it('clears currentRunId on pi.run.failed', async () => {
    const { result, es } = await setupHook()
    await act(async () => { await result.current.send('hello') })
    act(() => { es().fire('pi.run.failed', { event: 'pi.run.failed', data: {} }) })
    await waitFor(() => expect(result.current.currentRunId).toBeNull())
  })
})
