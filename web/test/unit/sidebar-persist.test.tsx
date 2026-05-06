/**
 * Vitest: clicking the collapse button persists collapsed=true to localStorage,
 * and reloading restores it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { act } from 'react'

import { App } from '../../src/App'

beforeEach(() => {
  localStorage.clear()
  // Stub probe — we only want to exercise the shell, not network.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.endsWith('/api/probe')) {
      return new Response(JSON.stringify({
        pi: { ok: true, version: '0.73.0', activeProvider: null, activeModel: null },
        confluence: { ok: false, configured: false },
        skills: { count: 0 }, agents: { count: 0 }, workflows: { count: 0 }, memory: { count: 0 },
        souls: { count: 0 }, jobs: { count: 0 }, tasks: { count: 0, byStatus: {} },
        terminal: { count: 0 }, db: { ok: true, schemaVersion: 2 },
        mcp: { servers: [] },
        auth: { piAuthJsonPresent: false },
        workspace: { kbRoot: '/tmp', skillsDir: '/tmp/skills', runsDir: '/tmp/runs' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (typeof url === 'string' && url.includes('/api/dashboard/intelligence')) {
      return new Response(JSON.stringify({
        windowDays: 7, sessionsCount: 0, apiCallsCount: 0,
        tokenTotals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        topModels: [], cacheContribution: 0, usageTrend: [],
        sessionsIntelligence: [],
        hourOfDayHistogram: Array.from({ length: 24 }, (_, h) => ({ hourUtc: h, count: 0, tokens: 0 })),
        tokenMix: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        topTools: [], activeModel: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (typeof url === 'string' && url.endsWith('/api/sessions')) {
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }))
})

async function flushAsync() {
  await act(async () => { await Promise.resolve() })
}

describe('sidebar persistence', () => {
  it('starts expanded by default', async () => {
    render(<App />)
    await flushAsync()
    expect(screen.getByTestId('sidebar-expanded')).toBeInTheDocument()
    expect(localStorage.getItem('hive.sidebarCollapsed')).toBe('0')
  })

  it('collapses on click and writes to localStorage', async () => {
    render(<App />)
    await flushAsync()
    const collapseBtn = screen.getByTestId('sb-collapse')
    fireEvent.click(collapseBtn)
    await flushAsync()
    expect(screen.getByTestId('sidebar-collapsed')).toBeInTheDocument()
    expect(localStorage.getItem('hive.sidebarCollapsed')).toBe('1')
  })

  it('restores collapsed state from localStorage on mount', async () => {
    localStorage.setItem('hive.sidebarCollapsed', '1')
    render(<App />)
    await flushAsync()
    expect(screen.getByTestId('sidebar-collapsed')).toBeInTheDocument()
  })
})

describe('screen selection', () => {
  it('persists active screen on click', async () => {
    render(<App />)
    await flushAsync()
    // Sessions now wires to a real SessionsScreen (testid 'sessions') after
    // the polish pass; clicking it persists the route.
    fireEvent.click(screen.getByTestId('sb-item-sessions'))
    await flushAsync()
    expect(localStorage.getItem('hive.activeScreen')).toBe('sessions')
    expect(screen.getByTestId('sessions')).toBeInTheDocument()
  })

  it('preview screens render the PREVIEW badge', async () => {
    render(<App />)
    await flushAsync()
    fireEvent.click(screen.getByTestId('sb-item-teams'))
    await flushAsync()
    // Teams (renamed from Swarm) is the only PREVIEW screen now. Files +
    // Operations were dropped, Conductor was renamed to Workflows and
    // wired to the real /api/workflows backend.
    expect(screen.getByTestId('screen-teams-preview')).toHaveTextContent('PREVIEW')
  })
})
