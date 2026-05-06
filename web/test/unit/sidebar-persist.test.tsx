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
    fireEvent.click(screen.getByTestId('sb-item-chat'))
    await flushAsync()
    expect(localStorage.getItem('hive.activeScreen')).toBe('chat')
    expect(screen.getByTestId('screen-chat')).toBeInTheDocument()
  })

  it('preview screens render the PREVIEW badge', async () => {
    render(<App />)
    await flushAsync()
    fireEvent.click(screen.getByTestId('sb-item-swarm'))
    await flushAsync()
    expect(screen.getByTestId('screen-swarm')).toHaveTextContent('PREVIEW')
  })
})
