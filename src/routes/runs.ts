import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Wiring } from '../server/wiring.js'
import {
  jsonError,
  matchPath,
  parsePath,
  parseQuery,
  sseHeaders,
  sseWrite,
  sseComment,
} from '../server/http-helpers.js'
import type { EnrichedEvent } from '../types/run.js'

export const RUNS_EVENTS_PATTERN = '/api/runs/:runId/events'

const TERMINAL_STATUSES = new Set(['success', 'error', 'cancelled'])

/**
 * Replay-aware SSE handler. Implements the queueing → streaming pattern
 * from locked spec §2.4: subscribe BEFORE drain, queue live events during
 * drain, dedupe by numeric seq, then flip to live streaming with the same
 * handler. If the run already terminated and the backlog is exhausted,
 * close the response cleanly.
 */
export async function handleRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  const params = matchPath(RUNS_EVENTS_PATTERN, parsePath(req.url))
  if (!params || !params.runId) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown runs events path')
    return
  }
  const runId: string = params.runId

  // Locked spec §2.4 allows EITHER `?afterSeq=N` query param OR a
  // `Last-Event-ID: <runId>:<seq>` header (used by EventSource auto-reconnect).
  // Query param wins if both are present. Mismatched runId in the header is a
  // 400 (a fresh client shouldn't carry someone else's resume token).
  const q = parseQuery(req.url)
  const afterSeqRaw = q.get('afterSeq')
  let afterSeq = 0
  if (afterSeqRaw != null) {
    if (!/^\d+$/.test(afterSeqRaw)) {
      jsonError(res, 400, 'BAD_REQUEST', 'afterSeq must be a non-negative integer', {
        received: afterSeqRaw,
      })
      return
    }
    afterSeq = Number(afterSeqRaw)
  } else {
    const headerRaw = req.headers['last-event-id']
    const header = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw
    if (header) {
      // Split at the LAST colon so runIds with colons themselves are tolerated.
      const colon = header.lastIndexOf(':')
      const headerRunId = colon > 0 ? header.slice(0, colon) : ''
      const seqStr = colon > 0 ? header.slice(colon + 1) : ''
      if (!headerRunId || !/^\d+$/.test(seqStr)) {
        jsonError(res, 400, 'BAD_REQUEST', 'Last-Event-ID must match `<runId>:<seq>`', {
          received: header,
        })
        return
      }
      if (headerRunId !== runId) {
        jsonError(res, 400, 'BAD_REQUEST', 'Last-Event-ID runId does not match path', {
          headerRunId,
          pathRunId: runId,
        })
        return
      }
      afterSeq = Number(seqStr)
    }
  }

  const meta = await w.runStore.getMeta(runId)
  if (!meta) {
    jsonError(res, 404, 'UNKNOWN_RUN', `run ${runId} does not exist`)
    return
  }

  res.writeHead(200, sseHeaders())
  sseComment(res, `run ${runId} replay afterSeq=${afterSeq}`)

  let mode: 'queueing' | 'streaming' = 'queueing'
  const queue: EnrichedEvent[] = []
  const seen = new Set<number>()
  let closed = false

  const writeOne = (e: EnrichedEvent) => {
    if (closed) return
    if (seen.has(e.meta.seq)) return
    seen.add(e.meta.seq)
    sseWrite(res, { id: e.meta.eventId, event: e.event, data: e })
  }

  let unsub: () => void = () => undefined
  let heartbeat: NodeJS.Timeout | null = null

  const cleanupAndEnd = () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    unsub()
    try {
      sseComment(res, 'end-of-stream')
    } catch {
      // ignore
    }
    res.end()
  }

  const handler = (e: EnrichedEvent) => {
    if (e.meta.runId !== runId) return
    if (mode === 'queueing') {
      queue.push(e)
    } else {
      writeOne(e)
      // End the stream the moment the live run.completed flushes — no polling.
      if (e.event === 'run.completed') cleanupAndEnd()
    }
  }
  unsub = w.bus.subscribe(handler)

  heartbeat = setInterval(() => {
    if (!closed) sseWrite(res, { event: 'heartbeat', data: { ts: Date.now() } })
  }, 30_000)

  req.on('close', () => {
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    unsub()
  })

  try {
    const backlog = await w.runStore.getEvents(runId, { afterSeq })
    if (closed) return
    for (const e of backlog) writeOne(e)

    while (queue.length > 0) {
      const e = queue.shift()!
      writeOne(e)
    }

    mode = 'streaming'

    // If the run is already terminal (any backlog event was run.completed,
    // OR meta.json says so), close cleanly. The handler-driven path covers
    // the live case; this guard catches "subscribed too late, completed
    // before drain finished".
    const finalStatus = await w.runStore.getStatus(runId)
    if (finalStatus && TERMINAL_STATUSES.has(finalStatus)) {
      cleanupAndEnd()
      return
    }
    // Otherwise the handler will close the stream when run.completed arrives.
  } catch (err) {
    console.error('[runs] replay failed:', err)
    cleanupAndEnd()
  }
}
