import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import type { Wiring } from '../server/wiring.js'
import { jsonError, jsonOk, readJsonBody } from '../server/http-helpers.js'

export const SEND_STREAM_PATH = '/api/send-stream'

export async function handleSendStream(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    const code = (err as Error & { code?: string }).code ?? 'BAD_REQUEST'
    jsonError(res, 400, code, (err as Error).message)
    return
  }
  if (!body || typeof body !== 'object') {
    jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object', { body })
    return
  }
  const { sessionKey, message } = body as Record<string, unknown>
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
    jsonError(res, 400, 'BAD_REQUEST', 'sessionKey must be a non-empty string', {
      received: typeof sessionKey,
    })
    return
  }
  if (typeof message !== 'string' || message.length === 0) {
    jsonError(res, 400, 'BAD_REQUEST', 'message must be a non-empty string', {
      received: typeof message,
    })
    return
  }
  if (!w.sessions.has(sessionKey)) {
    jsonError(res, 404, 'UNKNOWN_SESSION', `session ${sessionKey} does not exist`, { sessionKey })
    return
  }

  const runId = randomUUID()
  try {
    w.tracker.start(sessionKey, runId)
  } catch (err) {
    const e = err as Error & { code?: string; activeRunId?: string }
    if (e.code === 'ACTIVE_RUN') {
      jsonError(res, 409, 'ACTIVE_RUN', 'a run is already in flight for this session', {
        sessionKey,
        activeRunId: e.activeRunId ?? null,
      })
      return
    }
    throw err
  }

  try {
    await w.runStore.startRun({ runId, sessionKey, prompt: message })
    await w.bridge.send({ sessionKey, runId, prompt: message })
  } catch (err) {
    const e = err as Error & { code?: string; activeRunId?: string }
    // Roll back tracker; the run never made it to pi.
    w.tracker.finish(sessionKey, runId)
    await w.runStore.casStatus(runId, ['running'], 'error', {
      finishedAt: Date.now(),
      error: e.message,
    })
    // The pi child can only handle one prompt at a time. If a different session
    // already owns the bridge, surface as 409 ACTIVE_RUN with the OTHER run's id.
    if (e.code === 'BRIDGE_BUSY') {
      jsonError(res, 409, 'ACTIVE_RUN', 'pi is currently servicing another run', {
        activeRunId: e.activeRunId ?? null,
      })
      return
    }
    jsonError(res, 500, 'BRIDGE_FAILURE', `failed to send to pi: ${e.message}`)
    return
  }

  jsonOk(res, 202, { runId })
}
