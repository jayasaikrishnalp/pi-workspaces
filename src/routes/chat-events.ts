import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Wiring } from '../server/wiring.js'
import {
  jsonError,
  parseQuery,
  sseHeaders,
  sseWrite,
  sseComment,
} from '../server/http-helpers.js'

export const CHAT_EVENTS_PATH = '/api/chat-events'

export function handleChatEvents(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): void {
  const q = parseQuery(req.url)
  const sessionKey = q.get('sessionKey')
  if (!sessionKey) {
    jsonError(res, 400, 'BAD_REQUEST', 'sessionKey query parameter is required')
    return
  }
  if (!w.sessions.has(sessionKey)) {
    jsonError(res, 404, 'UNKNOWN_SESSION', `session ${sessionKey} does not exist`)
    return
  }

  res.writeHead(200, sseHeaders())
  sseComment(res, `chat-events session=${sessionKey}`)

  const unsub = w.bus.subscribe((e) => {
    if (e.meta.sessionKey !== sessionKey) return
    sseWrite(res, { id: e.meta.eventId, event: e.event, data: { ...e, meta: e.meta } })
  })

  // Heartbeat every 30s to keep proxies happy.
  const hb = setInterval(() => {
    sseWrite(res, { event: 'heartbeat', data: { ts: Date.now() } })
  }, 30_000)

  req.on('close', () => {
    clearInterval(hb)
    unsub()
  })
}
