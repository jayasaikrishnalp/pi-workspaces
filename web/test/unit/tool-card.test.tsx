/**
 * Vitest: ToolCard rendering.
 *   - status badge maps to phase label (preparing/running/completed/failed)
 *   - args preview shown inline when args present
 *   - card auto-expands on first 'completed' or 'errored' status
 *   - user toggle wins after explicit click
 *   - INPUT / OUTPUT / ERROR sections render the right testids
 */

import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { ToolCard } from '../../src/components/chat/ToolCard'
import type { ToolCall } from '../../src/lib/streamingMessage'

function call(over: Partial<ToolCall>): ToolCall {
  return { id: 'tc1', name: 'bash', status: 'pending', ...over }
}

describe('ToolCard', () => {
  it('shows the phase label that matches status', () => {
    const { rerender } = render(<ToolCard call={call({ status: 'pending' })} />)
    expect(screen.getByText('preparing')).toBeInTheDocument()
    rerender(<ToolCard call={call({ status: 'running' })} />)
    expect(screen.getByText('running')).toBeInTheDocument()
    rerender(<ToolCard call={call({ status: 'completed' })} />)
    expect(screen.getByText('completed')).toBeInTheDocument()
    rerender(<ToolCard call={call({ status: 'errored', error: 'exit 1' })} />)
    expect(screen.getByText('failed')).toBeInTheDocument()
  })

  it('renders an args preview line in the collapsed header when args exist', () => {
    render(<ToolCard call={call({ status: 'running', args: { command: 'ls -la /tmp' } })} />)
    const preview = screen.getByTestId('tool-card-tc1-preview')
    expect(preview.textContent).toMatch(/command/)
    expect(preview.textContent).toMatch(/ls -la/)
  })

  it('truncates a long args preview to 60 chars + …', () => {
    const long = 'x'.repeat(200)
    render(<ToolCard call={call({ status: 'running', args: { command: long } })} />)
    const preview = screen.getByTestId('tool-card-tc1-preview')
    expect(preview.textContent!.length).toBeLessThanOrEqual(60)
    expect(preview.textContent!.endsWith('…')).toBe(true)
  })

  it('auto-expands once status flips to completed', () => {
    const { rerender } = render(
      <ToolCard call={call({ status: 'pending', name: 'bash' })} />,
    )
    expect(screen.queryByTestId('tool-card-tc1-args')).toBeNull()
    rerender(
      <ToolCard call={call({
        status: 'completed',
        args: { command: 'ls' },
        result: 'file1\nfile2\n',
      })} />,
    )
    expect(screen.getByTestId('tool-card-tc1-args')).toBeVisible()
    expect(screen.getByTestId('tool-card-tc1-result')).toHaveTextContent(/file1/)
  })

  it('auto-expands once status flips to errored, with error pane', () => {
    const { rerender } = render(<ToolCard call={call({ status: 'pending' })} />)
    rerender(
      <ToolCard call={call({
        status: 'errored',
        args: { command: 'fail' },
        error: 'exit code 1',
      })} />,
    )
    expect(screen.getByTestId('tool-card-tc1-error')).toHaveTextContent('exit code 1')
  })

  it('user toggle wins — clicking close before completion stays closed', () => {
    const { rerender } = render(
      <ToolCard call={call({ status: 'running', args: { command: 'ls' } })} />,
    )
    // Card is closed initially (status running, not auto-expand trigger)
    expect(screen.queryByTestId('tool-card-tc1-args')).toBeNull()
    // User clicks open
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByTestId('tool-card-tc1-args')).toBeVisible()
    // User clicks close BEFORE completion arrives
    fireEvent.click(screen.getByRole('button', { expanded: true }))
    expect(screen.queryByTestId('tool-card-tc1-args')).toBeNull()
    // Now status flips to completed — should NOT override the user's toggle
    rerender(
      <ToolCard call={call({
        status: 'completed',
        args: { command: 'ls' },
        result: 'output',
      })} />,
    )
    expect(screen.queryByTestId('tool-card-tc1-args')).toBeNull()
  })

  it('shows a friendly placeholder when expanded but neither args nor result are present', () => {
    render(<ToolCard call={call({ status: 'completed' })} />)
    // status=completed → auto-expands; no args, no result → placeholder
    expect(screen.getByText(/no input or output yet/i)).toBeInTheDocument()
  })

  it('does not render args/result sections when those fields are missing', () => {
    render(<ToolCard call={call({ status: 'pending' })} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByTestId('tool-card-tc1-args')).toBeNull()
    expect(screen.queryByTestId('tool-card-tc1-result')).toBeNull()
  })
})
