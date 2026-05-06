/**
 * Reducer-level tests for streamingMessage. Pure-function — no React.
 */

import { describe, it, expect } from 'vitest'

import { reduce, appendUserMessage, INITIAL_CHAT_STATE, type ChatState } from '../../src/lib/streamingMessage'

function feed(initial: ChatState, ...evts: Array<{ event: string; data: Record<string, unknown> }>): ChatState {
  return evts.reduce<ChatState>((s, e) => reduce(s, e), initial)
}

describe('streamingMessage reducer', () => {
  it('agent_start flips streaming on, clears prior error', () => {
    const s = feed({ ...INITIAL_CHAT_STATE, error: 'old' }, { event: 'agent_start', data: {} })
    expect(s.streaming).toBe(true)
    expect(s.error).toBeNull()
  })

  it('assistant.start appends an empty assistant message', () => {
    const s = feed(INITIAL_CHAT_STATE, { event: 'assistant.start', data: { messageId: 'm1' } })
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]!.id).toBe('m1')
    expect(s.messages[0]!.role).toBe('assistant')
    expect(s.messages[0]!.text).toBe('')
    expect(s.messages[0]!.streaming).toBe(true)
  })

  it('assistant.delta concatenates text against the matching messageId', () => {
    const s = feed(INITIAL_CHAT_STATE,
      { event: 'assistant.start', data: { messageId: 'm1' } },
      { event: 'assistant.delta', data: { messageId: 'm1', delta: 'Hello, ' } },
      { event: 'assistant.delta', data: { messageId: 'm1', delta: 'world!' } },
    )
    expect(s.messages[0]!.text).toBe('Hello, world!')
  })

  it('assistant.completed clears streaming + records usage', () => {
    const s = feed(INITIAL_CHAT_STATE,
      { event: 'assistant.start', data: { messageId: 'm1' } },
      { event: 'assistant.delta', data: { messageId: 'm1', delta: 'final' } },
      { event: 'assistant.completed', data: { messageId: 'm1', text: 'final', usage: { totalTokens: 42, durationMs: 1234 } } },
    )
    expect(s.messages[0]!.streaming).toBe(false)
    expect(s.messages[0]!.usage).toMatch(/42 tokens/)
    expect(s.messages[0]!.usage).toMatch(/1\.2s/)
  })

  it('thinking.delta accumulates into the latest assistant message', () => {
    const s = feed(INITIAL_CHAT_STATE,
      { event: 'assistant.start', data: { messageId: 'm1' } },
      { event: 'thinking.start', data: {} },
      { event: 'thinking.delta', data: { delta: 'first ' } },
      { event: 'thinking.delta', data: { delta: 'second' } },
    )
    expect(s.messages[0]!.thinking).toBe('first second')
  })

  it('tool.call.start → tool.result populates a ToolCall on the latest assistant', () => {
    const s = feed(INITIAL_CHAT_STATE,
      { event: 'assistant.start', data: { messageId: 'm1' } },
      { event: 'tool.call.start', data: { toolCallId: 'tc1', name: 'confluence_search', args: { query: 'cobra' } } },
      { event: 'tool.call.end', data: { toolCallId: 'tc1' } },
      { event: 'tool.result', data: { toolCallId: 'tc1', result: { hits: 5 }, durationMs: 1400 } },
    )
    const tc = s.messages[0]!.toolCalls[0]!
    expect(tc.id).toBe('tc1')
    expect(tc.name).toBe('confluence_search')
    expect(tc.status).toBe('completed')
    expect(tc.durationMs).toBe(1400)
    expect(tc.result).toEqual({ hits: 5 })
  })

  it('pi.run.failed marks the latest assistant as errored and clears streaming', () => {
    const s = feed(INITIAL_CHAT_STATE,
      { event: 'assistant.start', data: { messageId: 'm1' } },
      { event: 'pi.run.failed', data: { message: 'pi binary not found (ENOENT)' } },
    )
    expect(s.streaming).toBe(false)
    expect(s.error).toMatch(/ENOENT/)
    expect(s.messages[0]!.error).toMatch(/ENOENT/)
    expect(s.messages[0]!.streaming).toBe(false)
  })

  it('pi.run.completed clears streaming on the latest assistant without erroring', () => {
    const s = feed(INITIAL_CHAT_STATE,
      { event: 'assistant.start', data: { messageId: 'm1' } },
      { event: 'pi.run.completed', data: {} },
    )
    expect(s.streaming).toBe(false)
    expect(s.messages[0]!.error).toBeUndefined()
    expect(s.messages[0]!.streaming).toBe(false)
  })

  it('unknown events are no-ops', () => {
    const s = feed(INITIAL_CHAT_STATE, { event: 'made.up.event', data: {} })
    expect(s).toEqual(INITIAL_CHAT_STATE)
  })
})

describe('appendUserMessage', () => {
  it('inserts a synthetic user message at the end', () => {
    const s = appendUserMessage(INITIAL_CHAT_STATE, 'hi there')
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]!.role).toBe('user')
    expect(s.messages[0]!.text).toBe('hi there')
  })
})
