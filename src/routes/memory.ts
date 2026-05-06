import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  jsonError,
  jsonOk,
  matchPath,
  parsePath,
  readJsonBody,
} from '../server/http-helpers.js'
import type { Wiring } from '../server/wiring.js'
import {
  listMemory,
  readMemory,
  writeMemory,
  MemoryError,
  MEMORY_NAME_RE,
} from '../server/memory-writer.js'

export const MEMORY_PATH = '/api/memory'
export const MEMORY_DETAIL_PATTERN = '/api/memory/:name'

export async function handleMemoryList(_req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  try {
    const entries = await listMemory(w.kbRoot)
    jsonOk(res, 200, { entries })
  } catch (err) {
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}

export async function handleMemoryRead(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(MEMORY_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.name) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown memory path')
    return
  }
  const name: string = params.name
  if (!MEMORY_NAME_RE.test(name)) {
    jsonError(res, 400, 'INVALID_MEMORY_NAME', `name must match ${MEMORY_NAME_RE}`)
    return
  }
  try {
    const m = await readMemory(w.kbRoot, name)
    jsonOk(res, 200, m)
  } catch (err) {
    handleMemoryError(res, err)
  }
}

export async function handleMemoryWrite(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(MEMORY_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.name) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown memory path')
    return
  }
  const name: string = params.name
  if (!MEMORY_NAME_RE.test(name)) {
    jsonError(res, 400, 'INVALID_MEMORY_NAME', `name must match ${MEMORY_NAME_RE}`)
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    jsonError(res, 400, 'BAD_REQUEST', (err as Error).message)
    return
  }
  if (!body || typeof body !== 'object') {
    jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object')
    return
  }
  const { content } = body as Record<string, unknown>
  if (typeof content !== 'string') {
    jsonError(res, 400, 'BAD_REQUEST', 'content must be a string')
    return
  }
  try {
    const entry = await writeMemory(w.kbRoot, name, content)
    jsonOk(res, 200, entry)
  } catch (err) {
    handleMemoryError(res, err)
  }
}

function handleMemoryError(res: ServerResponse, err: unknown): void {
  if (err instanceof MemoryError) {
    const status =
      err.code === 'INVALID_MEMORY_NAME' ? 400
      : err.code === 'BODY_TOO_LARGE' ? 400
      : err.code === 'UNKNOWN_MEMORY' ? 404
      : 500
    jsonError(res, status, err.code, err.message)
    return
  }
  jsonError(res, 500, 'INTERNAL', (err as Error).message)
}
