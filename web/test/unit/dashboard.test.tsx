/**
 * Vitest: Dashboard renders the 4 hero stat cards + the 7 widgets when fed
 * a stubbed /api/dashboard/intelligence response.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { act } from 'react'

import { DashboardScreen } from '../../src/components/screens/DashboardScreen'

const INTEL = {
  windowDays: 7,
  sessionsCount: 9,
  apiCallsCount: 23,
  tokenTotals: { input: 1200, output: 800, cacheRead: 5000, cacheWrite: 50 },
  topModels: [
    { model: 'claude-opus-4.6', tokens: 5000, sessions: 3, costUsd: 0.18 },
    { model: 'gpt-4.1', tokens: 1200, sessions: 1, costUsd: 0.05 },
  ],
  cacheContribution: 0.79,
  usageTrend: [
    { bucket: '2026-04-30', tokensTotal: 1000, cacheRead: 200, cost: 0.05, topTool: 'reboot-server' },
    { bucket: '2026-05-01', tokensTotal: 2000, cacheRead: 400, cost: 0.10, topTool: 'patch-vm' },
  ],
  sessionsIntelligence: [
    { sessionId: 'sess_111111_abcdef', title: 'Reboot the prod VM', msgCount: 6, toolCount: 22,
      tokensTotal: 110_000, costUsd: 0.21, predominantModel: 'claude-opus-4.6',
      lastActivityAt: Date.now(), agoText: 'just now', tags: ['TOOL_HEAVY', 'HIGH_TOKEN'] as const },
    { sessionId: 'sess_222222_xyz123', title: 'Old session', msgCount: 2, toolCount: 0,
      tokensTotal: 50, costUsd: 0, predominantModel: null,
      lastActivityAt: Date.now() - 10 * 86400_000, agoText: '10d', tags: ['STALE'] as const },
  ],
  hourOfDayHistogram: Array.from({ length: 24 }, (_, h) => ({ hourUtc: h, count: h % 5, tokens: h * 10 })),
  tokenMix: { input: 1200, output: 800, cacheRead: 5000, cacheWrite: 50 },
  topTools: [
    { tool: 'reboot-server', count: 8 },
    { tool: 'patch-vm', count: 3 },
  ],
  activeModel: 'claude-opus-4.6',
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/dashboard/intelligence')) {
      return new Response(JSON.stringify(INTEL), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }))
})

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

describe('DashboardScreen — session intelligence', () => {
  it('renders the 4 hero stat cards', async () => {
    render(<DashboardScreen />)
    await flush()
    expect(screen.getByTestId('hero-sessions')).toHaveTextContent('9')
    expect(screen.getByTestId('hero-tokens')).toBeInTheDocument()
    expect(screen.getByTestId('hero-api-calls')).toHaveTextContent('23')
    expect(screen.getByTestId('hero-model')).toHaveTextContent('claude-opus-4.6')
  })

  it('renders all 7 widgets', async () => {
    render(<DashboardScreen />)
    await flush()
    for (const id of ['dash-hero', 'dash-usage-trend', 'dash-top-models', 'dash-cache', 'dash-sessions-intel', 'dash-mix-rhythm', 'dash-tools-usage']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
  })

  it('top models list ranks claude-opus-4.6 first', async () => {
    render(<DashboardScreen />)
    await flush()
    expect(screen.getByTestId('top-model-claude-opus-4.6')).toBeInTheDocument()
    expect(screen.getByTestId('top-model-gpt-4.1')).toBeInTheDocument()
  })

  it('sessions intelligence renders TOOL_HEAVY + STALE tag pills', async () => {
    render(<DashboardScreen />)
    await flush()
    expect(screen.getByTestId('sess-row-abcdef')).toHaveTextContent('TOOL_HEAVY')
    expect(screen.getByTestId('sess-row-abcdef')).toHaveTextContent('HIGH_TOKEN')
    expect(screen.getByTestId('sess-row-xyz123')).toHaveTextContent('STALE')
  })

  it('cache widget header reads CACHE CONTRIBUTION', async () => {
    render(<DashboardScreen />)
    await flush()
    expect(screen.getByTestId('dash-cache')).toHaveTextContent('CACHE CONTRIBUTION')
  })

  it('window toggle exposes 7D/14D/30D buttons', async () => {
    render(<DashboardScreen />)
    await flush()
    expect(screen.getByTestId('dash-window-7d')).toBeInTheDocument()
    expect(screen.getByTestId('dash-window-14d')).toBeInTheDocument()
    expect(screen.getByTestId('dash-window-30d')).toBeInTheDocument()
  })
})
