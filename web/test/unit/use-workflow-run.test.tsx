import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

import { useWorkflowRun } from '../../src/hooks/useWorkflowRun'
import type { Workflow } from '../../src/lib/workflows-store'
import type { Agent } from '../../src/lib/agents-store'

const WORKFLOW: Workflow = {
  id: 'wf-test',
  name: 'Test',
  task: '',
  createdAt: '2026-05-07T00:00:00Z',
  steps: [
    { id: 's1', agentId: 'agent-a', note: '' },
    { id: 's2', agentId: 'agent-a', note: '' },
  ],
}
const AGENTS: Agent[] = [
  { id: 'agent-a', name: 'A', kind: 'specialist', role: '', model: 'm', skills: [], prompt: 'p' },
]

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readyState = 0
  url: string
  listeners: Record<string, Array<(e: MessageEvent) => void>> = {}
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    if (!this.listeners[name]) this.listeners[name] = []
    this.listeners[name].push(fn)
  }
  emit(name: string, data: unknown) {
    const evt = new MessageEvent(name, { data: JSON.stringify(data) })
    for (const l of this.listeners[name] ?? []) l(evt)
  }
  close() { /* noop */ }
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/workflow-runs') && init?.method === 'POST' && !url.includes('/cancel')) {
      return new Response(JSON.stringify({ runId: 'run-fake-1' }), { status: 202, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/api/workflow-runs') && init?.method !== 'POST') {
      return new Response(JSON.stringify({ runs: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: 200 })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useWorkflowRun', () => {
  it('seeds idle cards keyed by stepId for the given workflow', () => {
    const { result } = renderHook(() => useWorkflowRun(WORKFLOW, AGENTS))
    expect(Object.keys(result.current.state.cards).sort()).toEqual(['s1', 's2'])
    expect(result.current.state.cards.s1.status).toBe('idle')
    expect(result.current.state.runId).toBe(null)
  })

  it('drives state through run.start → step events → run.end', async () => {
    const { result } = renderHook(() => useWorkflowRun(WORKFLOW, AGENTS))
    await act(async () => { await result.current.run() })
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1))
    const src = FakeEventSource.instances[0]!

    act(() => { src.emit('run.start', { stepCount: 2 }) })
    expect(result.current.state.status).toBe('running')
    expect(result.current.state.cards.s1.status).toBe('queued')

    act(() => { src.emit('step.start', { stepId: 's1', agentId: 'agent-a' }) })
    expect(result.current.state.cards.s1.status).toBe('running')
    expect(result.current.state.activeStepId).toBe('s1')

    act(() => { src.emit('step.output', { stepId: 's1', chunk: 'hello ' }) })
    act(() => { src.emit('step.output', { stepId: 's1', chunk: 'world' }) })
    expect(result.current.state.cards.s1.output).toBe('hello world')

    act(() => {
      src.emit('step.end', {
        stepId: 's1', status: 'completed',
        decision: 'ok', next: 's2', output: 'hello world',
      })
    })
    expect(result.current.state.cards.s1.decision).toBe('ok')
    expect(result.current.state.cards.s1.next).toBe('s2')
    expect(result.current.state.cards.s1.status).toBe('completed')

    act(() => {
      src.emit('step.start', { stepId: 's2', agentId: 'agent-a' })
      src.emit('step.end', { stepId: 's2', status: 'completed', decision: null, next: null, output: 'done' })
      src.emit('run.end', { status: 'completed' })
    })

    expect(result.current.state.status).toBe('completed')
    expect(result.current.state.cards.s2.status).toBe('completed')
    expect(result.current.state.activeStepId).toBe(null)
  })

  it('sends only the agents referenced by workflow.steps when calling startWorkflowRun', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const moreAgents: Agent[] = [
      ...AGENTS,
      { id: 'agent-extra', name: 'X', kind: 'specialist', role: '', model: 'm', skills: [], prompt: 'p' },
    ]
    const { result } = renderHook(() => useWorkflowRun(WORKFLOW, moreAgents))
    await act(async () => { await result.current.run() })
    const postCall = fetchSpy.mock.calls.find(([url, init]) =>
      typeof url === 'string' && url.includes('/api/workflow-runs') && init?.method === 'POST',
    )!
    const body = JSON.parse(postCall[1].body)
    expect(body.agents.map((a: Agent) => a.id)).toEqual(['agent-a'])
  })
})
