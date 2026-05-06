import type { ChatEventBus } from './chat-event-bus.js'
import type { Db } from './db.js'

/**
 * Single chat-event-bus subscriber that mirrors assistant message_end +
 * tool.call.start events to the chat_messages SQLite table. Every write
 * is idempotent via INSERT ... ON CONFLICT(id) DO NOTHING. Persistence
 * errors are logged but never propagated — the chat-events SSE consumer
 * MUST keep working even if SQLite hiccups.
 */
export interface PersisterHandle { stop: () => void; persistedRows: () => number }

interface UsageShape {
  input?: number; output?: number
  cacheRead?: number; cacheWrite?: number
  totalTokens?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
}

function asNumber(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }
function asString(v: unknown): string | null { return typeof v === 'string' && v.length > 0 ? v : null }

export function installPersister(bus: ChatEventBus, db: Db): PersisterHandle {
  const insertAssistant = db.prepare(`
    INSERT INTO chat_messages (
      id, run_id, session_id, role, content, tool_name, tool_calls,
      tokens_in, tokens_out, cache_read, cache_write, cost_usd,
      model, provider, api, response_id, duration_ms, created_at
    ) VALUES (
      ?, ?, ?, 'assistant', ?, NULL, NULL,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, NULL, ?
    ) ON CONFLICT(id) DO NOTHING
  `)
  const insertToolCall = db.prepare(`
    INSERT INTO chat_messages (
      id, run_id, session_id, role, content, tool_name, tool_calls,
      created_at
    ) VALUES (?, ?, ?, 'tool', NULL, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)

  let count = 0

  const handler = (e: unknown): void => {
    try {
      const evt = e as { event: string; data: Record<string, unknown>; meta?: { sessionKey?: string; runId?: string } }
      if (!evt?.event) return
      const sessionId = asString(evt.meta?.sessionKey)
      const runId = asString(evt.meta?.runId) ?? asString(evt.data?.runId) ?? ''
      const now = Date.now()

      if (evt.event === 'assistant.completed') {
        const messageId = asString(evt.data.messageId)
        if (!messageId) return
        const usage = (evt.data.usage as UsageShape | null | undefined) ?? null
        const cost = usage?.cost ?? null
        insertAssistant.run(
          messageId, runId, sessionId, asString(evt.data.content) ?? '',
          asNumber(usage?.input), asNumber(usage?.output),
          asNumber(usage?.cacheRead), asNumber(usage?.cacheWrite),
          asNumber(cost?.total),
          asString(evt.data.model), asString(evt.data.provider), asString(evt.data.api),
          asString(evt.data.responseId),
          now,
        )
        count++
        return
      }

      if (evt.event === 'tool.call.start') {
        const toolCallId = asString(evt.data.toolCallId)
        const toolName = asString(evt.data.name)
        if (!toolCallId || !toolName) return
        let argsJson: string | null = null
        try { argsJson = evt.data.args !== undefined ? JSON.stringify(evt.data.args) : null } catch { argsJson = null }
        insertToolCall.run(toolCallId, runId, sessionId, toolName, argsJson, now)
        count++
        return
      }
    } catch (err) {
      // Persister errors must never block the bus. Log and move on.
      console.error('[persister]', (err as Error).message)
    }
  }

  const unsubscribe = bus.subscribe(handler)
  return {
    stop: () => unsubscribe(),
    persistedRows: () => count,
  }
}
