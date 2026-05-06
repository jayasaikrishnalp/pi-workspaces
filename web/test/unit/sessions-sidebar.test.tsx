/**
 * Vitest: SessionsSidebar — in-chat collapsible session list.
 *
 * Spec:
 *   - Renders a heading 'Sessions' and a '+ New' button
 *   - Lists sessions, sorted newest-first by createdAt
 *   - Active session row gets data-active="true"
 *   - Each row shows the title (or short id fallback) + HH:MM · short-id subtitle
 *   - Title >30 chars is truncated with … in display, full text in title attr
 *   - Empty state when no sessions
 *   - Clicking a row calls onPick(sessionKey)
 *   - Clicking the rename ✎ button opens an inline input; pressing Enter calls
 *     onRename(key, newTitle); pressing Escape cancels with no callback
 *   - Clicking '+ New' calls onNewSession()
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

import { SessionsSidebar } from '../../src/components/chat/SessionsSidebar'
import type { SessionInfo } from '../../src/lib/api'

function setup(over: Partial<React.ComponentProps<typeof SessionsSidebar>> = {}) {
  const onPick = vi.fn()
  const onNewSession = vi.fn()
  const onRename = vi.fn()
  const props = {
    sessions: [] as SessionInfo[],
    activeKey: null as string | null,
    onPick, onNewSession, onRename,
    ...over,
  }
  render(<SessionsSidebar {...props} />)
  return { onPick, onNewSession, onRename }
}

const fixed = (ms: number, key: string, title?: string): SessionInfo => ({
  sessionKey: key, createdAt: ms, ...(title ? { title } : {}),
})

describe('SessionsSidebar', () => {
  it('renders the Sessions heading and a + New button', () => {
    setup()
    expect(screen.getByRole('heading', { name: /sessions/i })).toBeInTheDocument()
    expect(screen.getByTestId('sb-new-session')).toBeInTheDocument()
  })

  it('clicking + New invokes onNewSession', () => {
    const { onNewSession } = setup()
    fireEvent.click(screen.getByTestId('sb-new-session'))
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })

  it('shows the empty-state copy when no sessions', () => {
    setup()
    expect(screen.getByTestId('sb-empty')).toHaveTextContent(/no sessions yet/i)
  })

  it('lists sessions newest-first; clicking a row picks it', () => {
    const sessions = [
      fixed(1000, 'sess_old_xx_zzz111', 'Older'),
      fixed(3000, 'sess_new_yy_zzz333', 'Newest'),
      fixed(2000, 'sess_mid_zz_zzz222'),
    ]
    const { onPick } = setup({ sessions })
    const rows = screen.getAllByTestId(/^sb-row-sess_/)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('Newest')
    expect(rows[1]).toHaveTextContent(/zzz222/) // fallback to short id
    expect(rows[2]).toHaveTextContent('Older')
    // The row's primary button is what receives the pick click.
    fireEvent.click(within(rows[0]).getByRole('button', { name: /Newest/ }))
    expect(onPick).toHaveBeenCalledWith('sess_new_yy_zzz333')
  })

  it('marks the active session with data-active="true"', () => {
    const sessions = [
      fixed(1000, 'sess_a_111111_aaaaaa', 'A'),
      fixed(2000, 'sess_b_222222_bbbbbb', 'B'),
    ]
    setup({ sessions, activeKey: 'sess_a_111111_aaaaaa' })
    expect(screen.getByTestId('sb-row-sess_a_111111_aaaaaa')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('sb-row-sess_b_222222_bbbbbb')).toHaveAttribute('data-active', 'false')
  })

  it('truncates titles longer than 30 chars with an ellipsis but keeps full text in title attr', () => {
    const long = 'A'.repeat(50)
    const sessions = [fixed(1, 'sess_x_111111_xxxxxx', long)]
    setup({ sessions })
    const row = screen.getByTestId('sb-row-sess_x_111111_xxxxxx')
    const titleEl = within(row).getByTestId('sb-row-title')
    expect(titleEl.textContent!.length).toBeLessThanOrEqual(31)
    expect(titleEl.textContent!.endsWith('…')).toBe(true)
    expect(titleEl).toHaveAttribute('title', long)
  })

  it('rename flow: ✎ → input → Enter calls onRename(key, newTitle)', () => {
    const sessions = [fixed(1, 'sess_r_999999_zzzzzz', 'Old name')]
    const { onRename } = setup({ sessions })
    fireEvent.click(screen.getByTestId('sb-rename-sess_r_999999_zzzzzz'))
    const input = screen.getByTestId('sb-rename-input') as HTMLInputElement
    expect(input).toBeVisible()
    expect(input.value).toBe('Old name')
    fireEvent.change(input, { target: { value: 'Better name' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('sess_r_999999_zzzzzz', 'Better name')
  })

  it('rename flow: Escape cancels without firing onRename', () => {
    const sessions = [fixed(1, 'sess_r_999999_zzzzzz', 'Old name')]
    const { onRename } = setup({ sessions })
    fireEvent.click(screen.getByTestId('sb-rename-sess_r_999999_zzzzzz'))
    const input = screen.getByTestId('sb-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onRename).not.toHaveBeenCalled()
    // Input should be gone
    expect(screen.queryByTestId('sb-rename-input')).toBeNull()
  })
})
