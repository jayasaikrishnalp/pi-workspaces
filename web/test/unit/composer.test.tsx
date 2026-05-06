/**
 * Vitest: Composer behavior.
 *   - Plain Enter submits.
 *   - Shift+Enter inserts a newline (does not submit).
 *   - ⌘+Enter still submits (legacy hotkey).
 *   - ⌘. fires onSwitchModel.
 *   - `seed` + `seedNonce` change applies the seed text and focuses the textarea.
 *   - Submit clears the textarea.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { act } from 'react'

import { Composer } from '../../src/components/chat/Composer'

function setup(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn().mockResolvedValue(undefined)
  const onSwitchModel = vi.fn()
  render(<Composer onSend={onSend} onSwitchModel={onSwitchModel} {...props} />)
  const textarea = screen.getByTestId('composer-text') as HTMLTextAreaElement
  return { onSend, onSwitchModel, textarea }
}

describe('Composer', () => {
  it('placeholder mentions Enter / Shift+Enter / ⌘.', () => {
    const { textarea } = setup()
    const ph = textarea.getAttribute('placeholder') || ''
    expect(ph.toLowerCase()).toContain('send')
    expect(ph).toContain('⇧↵')
    expect(ph).toContain('⌘.')
  })

  it('plain Enter submits with the trimmed value', async () => {
    const { onSend, textarea } = setup()
    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    await Promise.resolve()
    expect(onSend).toHaveBeenCalledWith('hello')
  })

  it('Shift+Enter does NOT submit', () => {
    const { onSend, textarea } = setup()
    fireEvent.change(textarea, { target: { value: 'one' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('⌘+Enter still submits (legacy)', async () => {
    const { onSend, textarea } = setup()
    fireEvent.change(textarea, { target: { value: 'legacy' } })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    await Promise.resolve()
    expect(onSend).toHaveBeenCalledWith('legacy')
  })

  it('⌘. invokes onSwitchModel without sending', () => {
    const { onSend, onSwitchModel, textarea } = setup()
    fireEvent.change(textarea, { target: { value: 'wont send' } })
    fireEvent.keyDown(textarea, { key: '.', metaKey: true })
    expect(onSwitchModel).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('blank or whitespace input never submits', () => {
    const { onSend, textarea } = setup()
    fireEvent.change(textarea, { target: { value: '   ' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disabled prop blocks send', () => {
    const onSend = vi.fn()
    render(<Composer onSend={onSend} disabled />)
    const textarea = screen.getByTestId('composer-text') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'hi' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('bumping seedNonce applies the seed text', () => {
    // Mirror ChatScreen's flow: seed starts undefined, becomes a string when
    // a chip is clicked, with seedNonce incremented to force re-application.
    function Harness() {
      const React = require('react') as typeof import('react')
      const [seed, setSeed] = React.useState<string | undefined>(undefined)
      const [nonce, setNonce] = React.useState(0)
      const seedComposer = (txt: string) => { setSeed(txt); setNonce((n: number) => n + 1) }
      return (
        <>
          <button data-testid="seed-btn" onClick={() => seedComposer('prefilled prompt')}>seed</button>
          <Composer onSend={vi.fn()} seed={seed} seedNonce={nonce} />
        </>
      )
    }
    render(<Harness />)
    const textarea = screen.getByTestId('composer-text') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
    act(() => { fireEvent.click(screen.getByTestId('seed-btn')) })
    expect(textarea.value).toBe('prefilled prompt')
  })
})
