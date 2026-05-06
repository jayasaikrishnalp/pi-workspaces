import type { IncomingMessage, ServerResponse } from 'node:http'

import type { Wiring } from '../server/wiring.js'
import {
  jsonError,
  jsonOk,
  matchPath,
  parsePath,
  readJsonBody,
} from '../server/http-helpers.js'

const PATH_LIST = '/api/secrets'
const PATH_KEY = '/api/secrets/:key'

const MAX_KEY_LEN = 256

function decodeKey(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const decoded = decodeURIComponent(raw).trim()
    return decoded.length > 0 ? decoded : null
  } catch {
    return null
  }
}

/**
 * GET /api/secrets — list keys + updatedAt only. NEVER returns values.
 *
 * Sorted alphabetically by key. Returns 503 NO_SECRET_STORE if the wiring
 * was constructed without a SecretStore (test harness only).
 */
export function handleSecretsList(_req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  if (!w.secretStore) {
    jsonError(res, 503, 'NO_SECRET_STORE', 'workspace was started without a secret store')
    return
  }
  jsonOk(res, 200, { secrets: w.secretStore.listKeys() })
}

/**
 * PUT /api/secrets/:key  body: { value: string }
 * Sets or replaces the secret. Returns { key, updatedAt } — never echoes the value.
 */
export async function handleSecretsPut(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  const params = matchPath(PATH_KEY, parsePath(req.url))
  const key = decodeKey(params?.key)
  if (!key) {
    jsonError(res, 400, 'BAD_REQUEST', 'secret key must be a non-empty string')
    return
  }
  if (key.length > MAX_KEY_LEN) {
    jsonError(res, 400, 'BAD_REQUEST', `secret key too long (max ${MAX_KEY_LEN})`)
    return
  }
  if (!w.secretStore) {
    jsonError(res, 503, 'NO_SECRET_STORE', 'workspace was started without a secret store')
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    jsonError(res, 400, 'BAD_REQUEST', (err as Error).message)
    return
  }
  const value = (body && typeof body === 'object' ? (body as { value?: unknown }).value : undefined)
  if (typeof value !== 'string') {
    jsonError(res, 400, 'BAD_REQUEST', 'body.value must be a string')
    return
  }

  try {
    await w.secretStore.setSecret(key, value)
  } catch (err) {
    jsonError(res, 400, 'BAD_REQUEST', (err as Error).message)
    return
  }

  // Return only the key + updatedAt so the response can't accidentally leak
  // the value into a log / client cache / browser devtools history.
  const entry = w.secretStore.listKeys().find((e) => e.key === key)
  jsonOk(res, 200, { key, updatedAt: entry?.updatedAt ?? Date.now() })
}

/**
 * DELETE /api/secrets/:key — remove the secret. 404 UNKNOWN_SECRET if absent.
 */
export async function handleSecretsDelete(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  const params = matchPath(PATH_KEY, parsePath(req.url))
  const key = decodeKey(params?.key)
  if (!key) {
    jsonError(res, 400, 'BAD_REQUEST', 'secret key must be a non-empty string')
    return
  }
  if (!w.secretStore) {
    jsonError(res, 503, 'NO_SECRET_STORE', 'workspace was started without a secret store')
    return
  }
  const removed = await w.secretStore.deleteSecret(key)
  if (!removed) {
    jsonError(res, 404, 'UNKNOWN_SECRET', `secret ${key} does not exist`)
    return
  }
  jsonOk(res, 200, { deleted: true })
}

export const SECRETS_PATTERNS = {
  list: PATH_LIST,
  key: PATH_KEY,
}
