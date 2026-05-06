/**
 * Vitest: Message rendering — markdown for assistant, plain for user.
 *
 * Assistant text passes through react-markdown + remark-gfm so headings,
 * tables, lists, fenced code, inline code, links, bold/italic all render
 * as real DOM. User text stays plain so we don't accidentally render
 * model-influenced markup in the user's own bubble.
 */

import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { Message } from '../../src/components/chat/Message'
import type { ChatMessage } from '../../src/lib/streamingMessage'

function msg(over: Partial<ChatMessage> & { id: string; role: ChatMessage['role'] }): ChatMessage {
  return {
    text: '',
    toolCalls: [],
    streaming: false,
    createdAt: 0,
    ...over,
  } as ChatMessage
}

describe('Message — markdown rendering', () => {
  it('renders headings, lists, and bold from assistant markdown', () => {
    const md = '# Title\n\n- one\n- **two**\n- three'
    render(<Message msg={msg({ id: 'm1', role: 'assistant', text: md })} />)

    const text = screen.getByTestId('chat-msg-m1-text')
    expect(within(text).getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument()
    const list = within(text).getByRole('list')
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    // The bold marker becomes <strong>two</strong>
    expect(within(items[1]!).getByText('two').tagName).toBe('STRONG')
  })

  it('renders GFM tables (remark-gfm)', () => {
    const md = [
      '| Service | Status |',
      '| --- | --- |',
      '| AWS | ok |',
      '| Jira | down |',
    ].join('\n')
    render(<Message msg={msg({ id: 'm2', role: 'assistant', text: md })} />)

    const table = screen.getByRole('table')
    expect(within(table).getByText('Service')).toBeInTheDocument()
    expect(within(table).getByText('Jira')).toBeInTheDocument()
    expect(within(table).getByText('down')).toBeInTheDocument()
  })

  it('renders fenced code blocks and inline code', () => {
    const md = 'Run `npm test` then:\n\n```bash\necho hello\n```'
    render(<Message msg={msg({ id: 'm3', role: 'assistant', text: md })} />)

    const text = screen.getByTestId('chat-msg-m3-text')
    // Inline code: <code> inside a paragraph
    const inline = within(text).getByText('npm test')
    expect(inline.tagName).toBe('CODE')
    // Fenced code: <pre><code>
    const fenced = text.querySelector('pre code')
    expect(fenced).not.toBeNull()
    expect(fenced!.textContent).toContain('echo hello')
  })

  it('renders links as anchors with the markdown URL', () => {
    const md = 'See [the docs](https://example.com/docs).'
    render(<Message msg={msg({ id: 'm4', role: 'assistant', text: md })} />)
    const a = screen.getByRole('link', { name: 'the docs' })
    expect(a).toHaveAttribute('href', 'https://example.com/docs')
  })

  it('opens external links in a new tab safely', () => {
    const md = '[external](https://example.com)'
    render(<Message msg={msg({ id: 'm5', role: 'assistant', text: md })} />)
    const a = screen.getByRole('link', { name: 'external' })
    expect(a).toHaveAttribute('target', '_blank')
    expect(a.getAttribute('rel') || '').toMatch(/noopener/)
    expect(a.getAttribute('rel') || '').toMatch(/noreferrer/)
  })

  it('user messages render as plain text — markdown source is preserved verbatim', () => {
    const md = '# this is not a heading\n- nor a list'
    render(<Message msg={msg({ id: 'u1', role: 'user', text: md })} />)
    const text = screen.getByTestId('chat-msg-u1-text')
    // No <h1>, no <ul>
    expect(text.querySelector('h1')).toBeNull()
    expect(text.querySelector('ul')).toBeNull()
    // Raw text preserved
    expect(text.textContent).toContain('# this is not a heading')
    expect(text.textContent).toContain('- nor a list')
  })

  it('does NOT render raw HTML embedded in markdown (XSS guard)', () => {
    const md = 'hi <script>window.__pwn = true</script> there'
    render(<Message msg={msg({ id: 'm6', role: 'assistant', text: md })} />)
    const text = screen.getByTestId('chat-msg-m6-text')
    expect(text.querySelector('script')).toBeNull()
    expect((window as unknown as { __pwn?: boolean }).__pwn).toBeUndefined()
  })
})
