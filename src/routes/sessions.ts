import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import type { Wiring } from '../server/wiring.js'
import {
  jsonError,
  jsonOk,
  matchPath,
  parsePath,
} from '../server/http-helpers.js'
import type { SessionInfo } from '../types/run.js'

const PATH_LIST = '/api/sessions'
const PATH_ACTIVE_RUN = '/api/sessions/:sessionKey/active-run'

export function handleSessionsCreate(_req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const sessionKey = randomUUID()
  const info: SessionInfo = { sessionKey, createdAt: Date.now() }
  w.sessions.set(sessionKey, info)
  jsonOk(res, 201, { sessionKey })
}

export function handleSessionsList(_req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const sessions = Array.from(w.sessions.values())
  jsonOk(res, 200, { sessions })
}

export async function handleActiveRun(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  const params = matchPath(PATH_ACTIVE_RUN, parsePath(req.url))
  if (!params || !params.sessionKey) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown active-run path')
    return
  }
  const sessionKey: string = params.sessionKey
  if (!w.sessions.has(sessionKey)) {
    jsonError(res, 404, 'UNKNOWN_SESSION', `session ${sessionKey} does not exist`)
    return
  }
  const runId = w.tracker.getActive(sessionKey)
  if (!runId) {
    jsonOk(res, 200, { runId: null })
    return
  }
  const status = (await w.runStore.getStatus(runId)) ?? 'running'
  jsonOk(res, 200, { runId, status })
}

export const SESSIONS_PATTERNS = {
  list: PATH_LIST,
  activeRun: PATH_ACTIVE_RUN,
}
