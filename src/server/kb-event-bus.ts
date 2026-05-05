import type { KbEvent } from '../types/kb.js'

type Handler = (e: KbEvent) => void

export class KbEventBus {
  private handlers = new Set<Handler>()

  subscribe(handler: Handler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  emit(e: KbEvent): void {
    const snapshot = Array.from(this.handlers)
    for (const h of snapshot) {
      try {
        h(e)
      } catch (err) {
        console.error('[kb-event-bus] subscriber threw:', err)
      }
    }
  }

  size(): number {
    return this.handlers.size
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __kbEventBus: KbEventBus | undefined
}

export function getKbEventBus(): KbEventBus {
  if (!globalThis.__kbEventBus) globalThis.__kbEventBus = new KbEventBus()
  return globalThis.__kbEventBus
}
