import type { NormalizedEvent } from '../events/types.js'

export type RunStatus = 'running' | 'success' | 'error' | 'cancelled'

export interface RunMeta {
  runId: string
  sessionKey: string
  prompt: string
  status: RunStatus
  startedAt: number
  finishedAt?: number
  error?: string | null
}

export interface EventMeta {
  runId: string
  sessionKey: string
  seq: number
  eventId: string
}

// What lands on the bus and on disk. Stage 1 produced NormalizedEvent;
// Stage 2 stamps run-scoped meta.
export type EnrichedEvent = NormalizedEvent & { meta: EventMeta }

export interface SessionInfo {
  sessionKey: string
  createdAt: number
}
