/**
 * Subscribe a single handler to multiple named SSE events on an EventSource.
 *
 * The browser's EventSource only fires the default `'message'` listener for
 * frames that have NO `event:` field. Frames written by sseWrite include the
 * `event:` line, so they only dispatch to listeners explicitly registered for
 * that name. This helper attaches the same dispatcher to every name in
 * `events` plus the catch-all `'message'`, returning an unsubscribe.
 */
export function subscribeNamedEvents(
  es: EventSource,
  events: readonly string[],
  handler: (e: MessageEvent) => void,
): () => void {
  const all = ['message', ...events]
  for (const name of all) es.addEventListener(name, handler as EventListener)
  return () => {
    for (const name of all) es.removeEventListener(name, handler as EventListener)
  }
}

/** Event names emitted on the chat-event channel (matches src/events/pi-event-mapper.ts + run-store). */
export const CHAT_EVENT_NAMES = [
  'agent_start', 'agent_end',
  'assistant.start', 'assistant.delta', 'assistant.completed',
  'thinking.start', 'thinking.delta', 'thinking.end',
  'tool.call.start', 'tool.call.delta', 'tool.call.end',
  'tool.result', 'tool.exec.start', 'tool.exec.update', 'tool.exec.end',
  'pi.error',
  // Real backend emits run.* (no prefix); kept the pi.run.* aliases for
  // back-compat with synthetic test fixtures and any older traces.
  'run.start', 'run.completed', 'run.failed', 'run.cancelled',
  'pi.run.completed', 'pi.run.failed', 'pi.run.cancelled',
  'turn.start', 'turn.end', 'user.message',
  'heartbeat',
] as const

/** Event names emitted on the kb-event channel. */
export const KB_EVENT_NAMES = ['kb.changed', 'heartbeat'] as const
