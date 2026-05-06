import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Wiring } from '../server/wiring.js'
import { jsonOk, jsonError, sseHeaders, sseWrite, sseComment } from '../server/http-helpers.js'
import { buildGraph } from '../server/kb-browser.js'

export const KB_GRAPH_PATH = '/api/kb/graph'
export const KB_EVENTS_PATH = '/api/kb/events'

export async function handleKbGraph(
  _req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  if (!w.kbRoot) {
    jsonError(res, 500, 'NO_KB_ROOT', 'workspace has no kb root configured')
    return
  }
  try {
    const graph = await buildGraph(w.kbRoot)
    jsonOk(res, 200, graph)
  } catch (err) {
    jsonError(res, 500, 'GRAPH_BUILD_FAILED', (err as Error).message)
  }
}

export function handleKbEvents(req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  if (!w.kbBus) {
    jsonError(res, 500, 'NO_KB_BUS', 'kb event bus not initialized')
    return
  }
  res.writeHead(200, sseHeaders())
  sseComment(res, 'kb events')

  const unsub = w.kbBus.subscribe((e) => {
    sseWrite(res, { event: 'kb.changed', data: e })
  })

  const hb = setInterval(() => {
    sseWrite(res, { event: 'heartbeat', data: { ts: Date.now() } })
  }, 30_000)

  req.on('close', () => {
    clearInterval(hb)
    unsub()
  })
}
