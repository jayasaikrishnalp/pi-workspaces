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

  it('tool.call.start → tool.result populates a ToolCall on the latest assistant (legacy synthetic shape)', () => {
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

  // ====================================================================
  // REAL backend event shapes — what src/events/pi-event-mapper.ts emits.
  // These are the shapes that arrive in production. The reducer MUST cope.
  // ====================================================================

  it('captures args from tool.call.end (real backend never sends args in tool.call.start)', () => {
    const s = feed(INITIAL_CHAT_STATE,
      { event: 'assistant.start', data: { messageId: 'm1' } },
      // Real start: name only, no args yet.
      { event: 'tool.call.start', data: { toolCallId: 'tc1', name: 'bash' } },
      // Real end: full args object as final value.
      { event: 'tool.call.end', data: { toolCallId: 'tc1', name: 'bash', args: { command: 'ls -la' } } },
    )
    const tc = s.messages[0]!.toolCalls[0]!
    expect(tc.name).toBe('bash')
    expect(tc.args).toEqual({ command: 'ls -la' })
    // After tool.call.end status moves to 'running' (about to execute).
    expect(tc.status).toBe('running')
  })

  it('accumulates argsDelta strings into a buffer during tool.call.delta', () => {
    const s = feed(INITIAL_CHAT_STATE,
      { event: 'assistant.start', data: { messageId: 'm1' } },
      { event: 'tool.call.start', data: { toolCallId: 'tc1', name: 'bash' } },
      { event: 'tool.call.delta', data: { toolCallId: 'tc1', argsDelta: '{"command":' } },
      { event: 'tool.call.delta', data: { toolCallId: 'tc1', argsDelta: '"echo hi"}' } },
    )
    const tc = s.messages[0]!.toolCalls[0]!
    // Mid-stream args buffer is the concatenated raw JSON text — useful for
    // showing typing-style preview while the LLM is still emitting.
    expect(tc.args).toBe('{"command":"echo hi"}')
  })

  it('reads tool.result content from data.content (real backend) or data.result (legacy)', () => {
    // Real backend shape — content is a string.
    const real = feed(INITIAL_CHAT_STATE,
      { event: 'assistant.start', data: { messageId: 'm1' } },
      { event: 'tool.call.start', data: { toolCallId: 'tc1', name: 'bash' } },
      { event: 'tool.call.end', data: { toolCallId: 'tc1', name: 'bash', args: { command: 'ls' } } },
      { event: 'tool.result', data: { toolCallId: 'tc1', content: 'total 0\nfile1.txt\nfile2.txt' } },
    )
    expect(real.messages[0]!.toolCalls[0]!.result).toBe('total 0\nfile1.txt\nfile2.txt')
    expect(real.messages[0]!.toolCalls[0]!.status).toBe('completed')

    // Legacy synthetic — `result` field carries an object.
    const legacy = feed(INITIAL_CHAT_STATE,
      { event: 'assistant.start', data: { messageId: 'm1' } },
      { event: 'tool.call.start', data: { toolCallId: 'tc1', name: 'x', args: { a: 1 } } },
      { event: 'tool.result', data: { toolCallId: 'tc1', result: { hits: 3 } } },
    )
    expect(legacy.messages[0]!.toolCalls[0]!.result).toEqual({ hits: 3 })
  })

  it('tool.exec.end with ok:false marks the call as errored', () => {
    const s = feed(INITIAL_CHAT_STATE,
      { event: 'assistant.start', data: { messageId: 'm1' } },
      { event: 'tool.call.start', data: { toolCallId: 'tc1', name: 'bash' } },
      { event: 'tool.call.end', data: { toolCallId: 'tc1', name: 'bash', args: { command: 'fail' } } },
      { event: 'tool.exec.end', data: { toolCallId: 'tc1', ok: false, error: 'exit 1' } },
    )
    const tc = s.messages[0]!.toolCalls[0]!
    expect(tc.status).toBe('errored')
    expect(tc.error).toBe('exit 1')
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
