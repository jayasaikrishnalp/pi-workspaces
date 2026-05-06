/**
 * Vitest: DashboardScreen renders all stat cards from /api/probe and recent
 * lists from /api/jobs + /api/tasks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { act } from 'react'

import { DashboardScreen } from '../../src/components/screens/DashboardScreen'

const PROBE = {
  pi: { ok: true, version: '0.73.0', activeProvider: 'github-copilot', activeModel: 'claude-sonnet-4.6', latencyMs: 12 },
  confluence: { ok: true, configured: true },
  skills: { count: 5 },
  agents: { count: 2 },
  workflows: { count: 1 },
  memory: { count: 3 },
  souls: { count: 4 },
  jobs: { count: 7 },
  tasks: { count: 9, byStatus: { todo: 3, done: 6 } },
  terminal: { count: 11 },
  db: { ok: true, schemaVersion: 2 },
  mcp: { servers: [
    { id: 'ref', kind: 'http', status: 'connected', toolCount: 2 },
    { id: 'context7', kind: 'stdio', status: 'disconnected', toolCount: 0 },
  ] },
  auth: { piAuthJsonPresent: true },
  workspace: { kbRoot: '/tmp/kb', skillsDir: '/tmp/kb/skills', runsDir: '/tmp/runs' },
}

const JOBS = { jobs: [
  { id: 'j1', soul_id: null, agent_id: null, run_id: 'r1', session_id: 's1', status: 'completed', title: 'first send', source: 'operator', created_at: Date.now() - 10_000, started_at: Date.now() - 9_000, completed_at: Date.now() - 5_000, summary: null, error: null },
  { id: 'j2', soul_id: null, agent_id: null, run_id: 'r2', session_id: 's1', status: 'running',   title: 'second send', source: 'operator', created_at: Date.now() - 1_000, started_at: Date.now() - 800, completed_at: null, summary: null, error: null },
] }

const TASKS = { tasks: [
  { id: 't1', title: 'check disk', body: null, status: 'todo',  priority: 0, source: 'operator', assignee_soul_id: null, parent_task_id: null, linked_job_id: null, created_by: null, created_at: Date.now(), started_at: null, completed_at: null, result: null, idempotency_key: null },
  { id: 't2', title: 'rotate keys', body: null, status: 'done', priority: 1, source: 'agent',    assignee_soul_id: null, parent_task_id: null, linked_job_id: null, created_by: null, created_at: Date.now(), started_at: null, completed_at: Date.now(), result: 'ok', idempotency_key: null },
] }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/probe')) return new Response(JSON.stringify(PROBE), { status: 200 })
    if (url.startsWith('/api/jobs')) return new Response(JSON.stringify(JOBS), { status: 200 })
    if (url.startsWith('/api/tasks')) return new Response(JSON.stringify(TASKS), { status: 200 })
    return new Response('{}', { status: 200 })
  }))
})

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('DashboardScreen', () => {
  it('renders 8 stat cards with live counts from /api/probe', async () => {
    render(<DashboardScreen />)
    await flush()
    expect(screen.getByTestId('stat-skills')).toHaveTextContent('5')
    expect(screen.getByTestId('stat-agents')).toHaveTextContent('2')
    expect(screen.getByTestId('stat-souls')).toHaveTextContent('4')
    expect(screen.getByTestId('stat-workflows')).toHaveTextContent('1')
    expect(screen.getByTestId('stat-memory')).toHaveTextContent('3')
    expect(screen.getByTestId('stat-jobs')).toHaveTextContent('7')
    expect(screen.getByTestId('stat-tasks')).toHaveTextContent('9')
    expect(screen.getByTestId('stat-terminal')).toHaveTextContent('11')
  })

  it('renders pi version + active model in the header sub-line', async () => {
    render(<DashboardScreen />)
    await flush()
    const header = screen.getByText(/pi 0\.73\.0/)
    expect(header).toBeInTheDocument()
    expect(header).toHaveTextContent('claude-sonnet-4.6')
  })

  it('renders MCP server pills with status classes', async () => {
    render(<DashboardScreen />)
    await flush()
    expect(screen.getByTestId('mcp-pill-ref')).toHaveTextContent('connected')
    expect(screen.getByTestId('mcp-pill-context7')).toHaveTextContent('disconnected')
  })

  it('renders recent jobs with their status', async () => {
    render(<DashboardScreen />)
    await flush()
    expect(screen.getByTestId('job-row-j1')).toHaveTextContent(/completed/i)
    expect(screen.getByTestId('job-row-j2')).toHaveTextContent(/running/i)
  })

  it('renders recent tasks with status + source', async () => {
    render(<DashboardScreen />)
    await flush()
    expect(screen.getByTestId('task-row-t1')).toHaveTextContent('check disk')
    expect(screen.getByTestId('task-row-t2')).toHaveTextContent('rotate keys')
    expect(screen.getByTestId('task-row-t2')).toHaveTextContent('agent')
  })
})
