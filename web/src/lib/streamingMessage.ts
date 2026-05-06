/**
 * Reducer that turns the backend's normalized chat-event stream into a
 * stable UI-ready `messages` array plus a `streaming` flag.
 *
 * Event taxonomy (from src/events/pi-event-mapper.ts on the backend):
 *   - `assistant.start`            { messageId }
 *   - `assistant.delta`            { messageId, delta }
 *   - `assistant.completed`        { messageId, text, usage? }
 *   - `thinking.start|delta|end`   { messageId, ... }
 *   - `tool.call.start|delta|end`  { toolCallId, name, args }
 *   - `tool.result`                { toolCallId, name, result, durationMs? }
 *   - `tool.exec.start|update|end` { toolCallId, ... }
 *   - `agent_start|agent_end`      { turnId, prompt? }
 *   - `pi.error`                   { message }
 *
 * Plus run-level events tracked by the run-store:
 *   - `pi.run.completed` / `pi.run.failed` / `pi.run.cancelled`
 *
 * The reducer is pure: same events → same output. UI just renders.
 */

export type Role = 'user' | 'assistant' | 'system'

export interface ToolCall {
  id: string
  name: string
  /** Final args (object) once tool.call.end lands, or the accumulated argsDelta string mid-stream. */
  args?: unknown
  result?: unknown
  status: 'pending' | 'running' | 'completed' | 'errored'
  durationMs?: number
  /** Error message when tool.exec.end arrives with ok:false. */
  error?: string
}

export interface ChatMessage {
  id: string
  role: Role
  text: string
  thinking?: string
  toolCalls: ToolCall[]
  streaming: boolean
  usage?: string
  error?: string
  createdAt: number
}

export interface ChatState {
  messages: ChatMessage[]
  streaming: boolean
  error: string | null
}

export const INITIAL_CHAT_STATE: ChatState = {
  messages: [],
  streaming: false,
  error: null,
}

interface ChatEvent {
  event: string
  data: Record<string, unknown>
  meta?: { runId?: string; sessionKey?: string; seq?: number; eventId?: string }
}

export function reduce(state: ChatState, e: ChatEvent): ChatState {
  switch (e.event) {
    case 'agent_start':
      return { ...state, streaming: true, error: null }

    case 'assistant.start': {
      const id = String(e.data.messageId ?? cryptoId())
      const msg: ChatMessage = { id, role: 'assistant', text: '', toolCalls: [], streaming: true, createdAt: Date.now() }
      return { ...state, messages: [...state.messages, msg], streaming: true }
    }

    case 'assistant.delta': {
      const id = String(e.data.messageId)
      const delta = String(e.data.delta ?? '')
      return updateMsg(state, id, (m) => ({ ...m, text: m.text + delta }))
    }

    case 'assistant.completed': {
      const id = String(e.data.messageId)
      const text = typeof e.data.text === 'string' ? e.data.text : undefined
      const usage = e.data.usage ? formatUsage(e.data.usage as Record<string, unknown>) : undefined
      return updateMsg(state, id, (m) => ({
        ...m,
        text: text ?? m.text,
        streaming: false,
        ...(usage ? { usage } : {}),
      }))
    }

    case 'thinking.start':
      return updateLatestAssistant(state, (m) => ({ ...m, thinking: '' }))
    case 'thinking.delta':
      return updateLatestAssistant(state, (m) => ({ ...m, thinking: (m.thinking ?? '') + String(e.data.delta ?? '') }))
    case 'thinking.end':
      return state // keep the accumulated thinking visible

    case 'tool.call.start': {
      const id = String(e.data.toolCallId)
      const name = String(e.data.name ?? 'tool')
      const args = e.data.args
      const newCall: ToolCall = { id, name, args, status: 'pending' }
      return updateLatestAssistant(state, (m) => ({ ...m, toolCalls: [...m.toolCalls, newCall] }))
    }

    case 'tool.call.delta': {
      // Real backend (pi-event-mapper) emits `argsDelta` — a partial JSON
      // string token. Accumulate it into a buffer for typing-style preview.
      // Legacy synthetic shape used `args` (full value) — preserve that path.
      const id = String(e.data.toolCallId)
      const argsDelta = e.data.argsDelta
      const fullArgs = e.data.args
      return updateLatestAssistant(state, (m) => ({
        ...m,
        toolCalls: m.toolCalls.map((c) => {
          if (c.id !== id) return c
          if (fullArgs !== undefined) return { ...c, args: fullArgs }
          if (typeof argsDelta === 'string' && argsDelta.length > 0) {
            const prior = typeof c.args === 'string' ? c.args : ''
            return { ...c, args: prior + argsDelta }
          }
          return c
        }),
      }))
    }

    case 'tool.call.end': {
      // Real backend emits the FINAL args object here (not in tool.call.start).
      // Always promote to 'running' (the call is now about to execute).
      const id = String(e.data.toolCallId)
      const finalArgs = e.data.args
      return updateLatestAssistant(state, (m) => ({
        ...m,
        toolCalls: m.toolCalls.map((c) =>
          c.id === id
            ? { ...c, status: 'running', ...(finalArgs !== undefined ? { args: finalArgs } : {}) }
            : c,
        ),
      }))
    }

    case 'tool.exec.end': {
      // Real backend signals success/failure at the end of execution.
      const id = String(e.data.toolCallId)
      const ok = e.data.ok !== false
      const errMsg = !ok ? String(e.data.error ?? 'tool failed') : undefined
      return updateLatestAssistant(state, (m) => ({
        ...m,
        toolCalls: m.toolCalls.map((c) =>
          c.id === id
            ? { ...c, status: ok ? c.status : 'errored', ...(errMsg ? { error: errMsg } : {}) }
            : c,
        ),
      }))
    }

    case 'tool.result': {
      // Real backend sends `content` (string from contentToText). Legacy
      // synthetic tests used `result`. Accept either.
      const id = String(e.data.toolCallId)
      const result = e.data.content !== undefined ? e.data.content : e.data.result
      const durationMs = typeof e.data.durationMs === 'number' ? e.data.durationMs : undefined
      return updateLatestAssistant(state, (m) => ({
        ...m,
        toolCalls: m.toolCalls.map((c) =>
          c.id === id ? { ...c, result, status: 'completed', ...(durationMs ? { durationMs } : {}) } : c,
        ),
      }))
    }

    case 'pi.error':
    case 'run.failed':
    case 'pi.run.failed': {
      const errMsg = String(e.data.message ?? e.data.error ?? 'pi error')
      return {
        ...state,
        streaming: false,
        error: errMsg,
        messages: state.messages.map((m, i) =>
          i === state.messages.length - 1 && m.role === 'assistant'
            ? { ...m, streaming: false, error: errMsg }
            : m,
        ),
      }
    }

    case 'run.completed':
    case 'run.cancelled':
    case 'pi.run.completed':
    case 'pi.run.cancelled':
      return {
        ...state,
        streaming: false,
        messages: state.messages.map((m, i) =>
          i === state.messages.length - 1 && m.role === 'assistant'
            ? { ...m, streaming: false }
            : m,
        ),
      }

    default:
      return state
  }
}

function updateMsg(state: ChatState, id: string, fn: (m: ChatMessage) => ChatMessage): ChatState {
  return {
    ...state,
    messages: state.messages.map((m) => (m.id === id ? fn(m) : m)),
  }
}

function updateLatestAssistant(state: ChatState, fn: (m: ChatMessage) => ChatMessage): ChatState {
  const idx = lastIndexOf(state.messages, (m) => m.role === 'assistant')
  if (idx < 0) return state
  return {
    ...state,
    messages: state.messages.map((m, i) => (i === idx ? fn(m) : m)),
  }
}

function lastIndexOf<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i
  return -1
}

function formatUsage(u: Record<string, unknown>): string {
  const t = typeof u.totalTokens === 'number' ? `${u.totalTokens} tokens` : null
  const ms = typeof u.durationMs === 'number' ? `${(u.durationMs / 1000).toFixed(1)}s` : null
  return [t, ms].filter(Boolean).join(' · ')
}

let counter = 0
function cryptoId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return `m_${++counter}_${Date.now()}`
}

/**
 * Append a synthetic user message to the local state. The backend doesn't echo
 * user prompts back as events; the UI optimistically inserts.
 */
export function appendUserMessage(state: ChatState, text: string): ChatState {
  const msg: ChatMessage = {
    id: cryptoId(),
    role: 'user',
    text,
    toolCalls: [],
    streaming: false,
    createdAt: Date.now(),
  }
  return { ...state, messages: [...state.messages, msg] }
}

/**
 * Replace messages wholesale from a hydrate-history payload. Used when a
 * session is reopened and we want to surface its persisted ChatMessage[]
 * without replaying streaming events.
 */
export function hydrate(state: ChatState, messages: ChatMessage[]): ChatState {
  return { ...state, messages, streaming: false, error: null }
}
