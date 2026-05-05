import type { EnrichedEvent } from '../types/run.js'

type Handler = (e: EnrichedEvent) => void

export class ChatEventBus {
  private handlers = new Set<Handler>()

  subscribe(handler: Handler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  emit(e: EnrichedEvent): void {
    // Snapshot so a handler that unsubscribes during iteration doesn't skip a peer.
    const snapshot = Array.from(this.handlers)
    for (const h of snapshot) {
      try {
        h(e)
      } catch (err) {
        // A misbehaving subscriber must not break the bus or other subscribers.
        console.error('[chat-event-bus] subscriber threw:', err)
      }
    }
  }

  size(): number {
    return this.handlers.size
  }
}

// Singleton on globalThis so dev-time module reloads don't orphan subscribers.
declare global {
  // eslint-disable-next-line no-var
  var __chatEventBus: ChatEventBus | undefined
}

export function getChatEventBus(): ChatEventBus {
  if (!globalThis.__chatEventBus) globalThis.__chatEventBus = new ChatEventBus()
  return globalThis.__chatEventBus
}
