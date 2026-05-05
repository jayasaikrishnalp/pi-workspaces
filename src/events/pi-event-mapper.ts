import type {
  MapperContext,
  MapperResult,
  MapperState,
  NormalizedEvent,
} from './types.js'

// All shapes here come from real `pi --mode json --print` output captured on
// the dev VM (pi v0.73). Reference traces live at
// tests/fixtures/pi-event-mapper/real-pi/. This mapper is the only place
// where pi's wire format is decoded; everything downstream sees the
// workspace's normalized event taxonomy from §2.1 of the locked spec.

function noop(state: MapperState): MapperResult {
  return { events: [], state }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

// Pi `content` is always an array of blocks: `[{type:"text", text}, ...]`.
// Workspace events surface a flattened text string. Non-text blocks are dropped
// here; if the UI needs them later, Stage 2+ can add a richer event.
// Strings are accepted unchanged — older spike traces used plain strings.
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!isObject(block)) return ''
        if (block.type === 'text') return asString(block.text) ?? ''
        return ''
      })
      .join('')
  }
  return ''
}

// Real pi `toolcall_start` / `toolcall_delta` carry the toolCall under
//   sub.partial.content[sub.contentIndex] = {type:"toolCall", id, name, arguments, partialJson}
// Real pi `toolcall_end` carries it directly:
//   sub.toolCall = {type:"toolCall", id, name, arguments}
// Older spike fixtures used flat fields (sub.toolCallId, sub.name, sub.argsDelta, sub.args).
// Read all three.
function findToolCallBlock(
  sub: Record<string, unknown>,
): Record<string, unknown> | null {
  if (isObject(sub.toolCall)) return sub.toolCall
  const partial = isObject(sub.partial) ? sub.partial : null
  const content = partial && Array.isArray(partial.content) ? partial.content : null
  const idx = typeof sub.contentIndex === 'number' ? sub.contentIndex : -1
  if (content && idx >= 0 && idx < content.length) {
    const block = content[idx]
    if (isObject(block) && block.type === 'toolCall') return block
  }
  return null
}

function extractToolCall(sub: Record<string, unknown>): {
  toolCallId: string
  name: string
  argsDelta: unknown
  args: unknown
} {
  const block = findToolCallBlock(sub)
  return {
    toolCallId: asString(sub.toolCallId) ?? asString(block?.id) ?? '',
    name: asString(sub.name) ?? asString(block?.name) ?? '',
    // Real pi delta is `sub.delta` (may be ''); spike used `sub.argsDelta`.
    argsDelta: sub.argsDelta ?? sub.delta ?? '',
    // Final args: prefer flat `args` (spike), then `block.arguments` (real pi).
    args: sub.args ?? block?.arguments ?? null,
  }
}

// `tool_execution_update.partialResult` is structured as `{content:[blocks], details}`
// in real pi. Older spike fixtures used a plain string `partial`. We pass through
// the structured object unchanged and let the UI decide how to render it; if the
// payload is a string, we pass that through too.
function passthroughPartial(piEvent: Record<string, unknown>): unknown {
  if (piEvent.partialResult !== undefined) return piEvent.partialResult
  if (piEvent.partial !== undefined) return piEvent.partial
  return ''
}

export function mapPiEvent(
  piEvent: unknown,
  state: MapperState,
  ctx: MapperContext,
): MapperResult {
  if (!isObject(piEvent)) return noop(state)
  const type = asString(piEvent.type)
  if (!type) return noop(state)

  const { runId, sessionKey } = ctx
  const turnId = state.currentTurnId

  switch (type) {
    case 'agent_start': {
      // Real pi `agent_start` is just `{type:"agent_start"}` — no prompt field.
      // The prompt comes from `ctx.prompt`, which the workspace sets from the
      // user's POST body. Falling back to event.prompt covers older traces.
      const prompt = ctx.prompt ?? asString(piEvent.prompt) ?? ''
      return {
        events: [{ event: 'run.start', data: { runId, sessionKey, prompt } }],
        // Reset per-run state so a stale prior run can never leak ids.
        state: { currentTurnId: null, currentMessageId: null },
      }
    }

    case 'agent_end': {
      // Real pi emits `agent_end { messages: [...] }`. On failure or abort the
      // last message is a synthetic assistant entry with
      // `stopReason: "aborted" | "error"` and `errorMessage` (see
      // ai-projects/pi-mono/packages/agent/src/agent.ts:463). Map those to
      // run.completed status accordingly. Default is "success".
      const messages = Array.isArray(piEvent.messages) ? piEvent.messages : []
      const last = messages.length > 0 ? messages[messages.length - 1] : null
      const stopReason = isObject(last) ? asString(last.stopReason) : undefined
      const errorMessage = isObject(last) ? asString(last.errorMessage) : undefined
      let status: 'success' | 'cancelled' | 'error' = 'success'
      if (stopReason === 'aborted') status = 'cancelled'
      else if (stopReason === 'error') status = 'error'
      const data: Record<string, unknown> = { runId, status }
      if (status !== 'success' && errorMessage) data.error = errorMessage
      return {
        events: [{ event: 'run.completed', data }],
        // Reset on completion regardless of whether matching turn_end /
        // message_end were observed.
        state: { currentTurnId: null, currentMessageId: null },
      }
    }

    case 'turn_start': {
      const newTurnId = ctx.nextTurnId()
      return {
        events: [{ event: 'turn.start', data: { runId, turnId: newTurnId } }],
        state: { ...state, currentTurnId: newTurnId },
      }
    }

    case 'turn_end': {
      if (turnId == null) return noop(state)
      return {
        events: [{ event: 'turn.end', data: { runId, turnId } }],
        state: { ...state, currentTurnId: null },
      }
    }

    case 'message_start': {
      const message = isObject(piEvent.message) ? piEvent.message : null
      if (!message) return noop(state)
      const role = asString(message.role)
      if (role !== 'assistant') return noop(state) // user + toolResult covered by message_end
      // Real pi AssistantMessage has no `id` — allocate one and remember it
      // for the duration of this assistant message. Honor a pi-supplied id if
      // a future version starts including one.
      const messageId = asString(message.id) ?? ctx.nextMessageId()
      return {
        events: [
          {
            event: 'assistant.start',
            data: { runId, turnId, messageId },
          },
        ],
        state: { ...state, currentMessageId: messageId },
      }
    }

    case 'message_update': {
      const sub = isObject(piEvent.assistantMessageEvent)
        ? piEvent.assistantMessageEvent
        : null
      if (!sub) return noop(state)
      const subType = asString(sub.type)
      if (!subType) return noop(state)
      const messageId =
        asString(piEvent.messageId) ?? state.currentMessageId ?? ''

      switch (subType) {
        case 'text_delta':
          return {
            events: [
              {
                event: 'assistant.delta',
                data: { runId, turnId, messageId, delta: sub.delta ?? '' },
              },
            ],
            state,
          }
        case 'thinking_start':
          return {
            events: [
              {
                event: 'thinking.start',
                data: { runId, turnId, messageId },
              },
            ],
            state,
          }
        case 'thinking_delta':
          return {
            events: [
              {
                event: 'thinking.delta',
                data: { runId, turnId, messageId, delta: sub.delta ?? '' },
              },
            ],
            state,
          }
        case 'thinking_end':
          return {
            events: [
              {
                event: 'thinking.end',
                data: { runId, turnId, messageId },
              },
            ],
            state,
          }
        case 'toolcall_start':
        case 'tool_call_start': {
          const tc = extractToolCall(sub)
          return {
            events: [
              {
                event: 'tool.call.start',
                data: {
                  runId,
                  turnId,
                  toolCallId: tc.toolCallId,
                  name: tc.name,
                },
              },
            ],
            state,
          }
        }
        case 'toolcall_delta':
        case 'tool_call_delta': {
          const tc = extractToolCall(sub)
          return {
            events: [
              {
                event: 'tool.call.delta',
                data: {
                  runId,
                  turnId,
                  toolCallId: tc.toolCallId,
                  argsDelta: tc.argsDelta,
                },
              },
            ],
            state,
          }
        }
        case 'toolcall_end':
        case 'tool_call_end': {
          const tc = extractToolCall(sub)
          return {
            events: [
              {
                event: 'tool.call.end',
                data: {
                  runId,
                  turnId,
                  toolCallId: tc.toolCallId,
                  name: tc.name,
                  args: tc.args,
                },
              },
            ],
            state,
          }
        }
        case 'text_start':
        case 'text_end':
          return noop(state) // UI infers from delta stream
        default:
          return noop(state)
      }
    }

    case 'message_end': {
      const message = isObject(piEvent.message) ? piEvent.message : null
      if (!message) return noop(state)
      const role = asString(message.role)
      if (role === 'user') {
        return {
          events: [
            {
              event: 'user.message',
              data: { runId, content: contentToText(message.content) },
            },
          ],
          state,
        }
      }
      if (role === 'assistant') {
        const messageId = asString(message.id) ?? state.currentMessageId ?? ''
        return {
          events: [
            {
              event: 'assistant.completed',
              data: {
                runId,
                turnId,
                messageId,
                content: contentToText(message.content),
                usage: message.usage ?? null,
              },
            },
          ],
          state: { ...state, currentMessageId: null },
        }
      }
      if (role === 'toolResult') {
        return {
          events: [
            {
              event: 'tool.result',
              data: {
                runId,
                turnId,
                toolCallId: asString(message.toolCallId) ?? '',
                content: contentToText(message.content),
              },
            },
          ],
          state,
        }
      }
      return noop(state)
    }

    case 'tool_execution_start': {
      return {
        events: [
          {
            event: 'tool.exec.start',
            data: {
              runId,
              turnId,
              toolCallId: asString(piEvent.toolCallId) ?? '',
              name: asString(piEvent.toolName) ?? asString(piEvent.name) ?? '',
            },
          },
        ],
        state,
      }
    }

    case 'tool_execution_update': {
      return {
        events: [
          {
            event: 'tool.exec.update',
            data: {
              runId,
              turnId,
              toolCallId: asString(piEvent.toolCallId) ?? '',
              partial: passthroughPartial(piEvent),
            },
          },
        ],
        state,
      }
    }

    case 'tool_execution_end': {
      // Real pi: `{ isError, result }`. Spike: `{ ok, error? }`.
      let ok: boolean
      if (typeof piEvent.ok === 'boolean') ok = piEvent.ok
      else if (typeof piEvent.isError === 'boolean') ok = !piEvent.isError
      else ok = true
      const data: Record<string, unknown> = {
        runId,
        turnId,
        toolCallId: asString(piEvent.toolCallId) ?? '',
        ok,
      }
      if (!ok) {
        const err =
          piEvent.error ?? (piEvent.isError === true ? piEvent.result : null)
        if (err != null) data.error = err
      }
      return { events: [{ event: 'tool.exec.end', data }], state }
    }

    case 'model_change': {
      return {
        events: [
          {
            event: 'model_change',
            data: {
              runId,
              sessionKey,
              modelId: asString(piEvent.modelId) ?? '',
              provider: asString(piEvent.provider) ?? '',
            },
          },
        ],
        state,
      }
    }

    // Pi's live RPC name is `thinking_level_changed` (past tense). Older
    // spike traces used `thinking_level_change`. Accept both.
    case 'thinking_level_change':
    case 'thinking_level_changed': {
      return {
        events: [
          {
            event: 'thinking_level_change',
            data: {
              runId,
              sessionKey,
              level:
                asString(piEvent.level) ??
                asString(piEvent.thinkingLevel) ??
                '',
            },
          },
        ],
        state,
      }
    }

    case 'error': {
      return {
        events: [
          {
            event: 'pi.error',
            data: {
              runId,
              code: asString(piEvent.code) ?? 'UNKNOWN',
              message: asString(piEvent.message) ?? '',
            },
          },
        ],
        state,
      }
    }

    // Real pi emits a leading `session` event with `{version, id, timestamp,
    // cwd}`. The workspace's `session.start` is workspace-emitted (carries
    // model + thinkingLevel from settings), so this pi event is intentionally
    // dropped here.
    case 'session':
      return noop(state)

    default:
      return noop(state)
  }
}
