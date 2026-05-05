import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  jsonError,
  jsonOk,
  readJsonBody,
} from '../server/http-helpers.js'
import {
  buildSetCookieHeader,
  buildClearCookieHeader,
  readCookie,
  COOKIE_NAME_EXPORT,
} from '../server/auth-middleware.js'
import type { Wiring } from '../server/wiring.js'

export const AUTH_LOGIN_PATH = '/api/auth/login'
export const AUTH_LOGOUT_PATH = '/api/auth/logout'
export const AUTH_CHECK_PATH = '/api/auth/check'

export async function handleAuthLogin(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  if (!w.authStore) {
    jsonError(res, 500, 'INTERNAL', 'auth store unavailable')
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
    jsonError(res, 400, 'BAD_REQUEST', 'body must be JSON object')
    return
  }
  const { token } = body as Record<string, unknown>
  if (typeof token !== 'string' || token.length === 0) {
    jsonError(res, 400, 'BAD_REQUEST', 'token must be a non-empty string')
    return
  }
  if (!w.authStore.verifyToken(token)) {
    // Don't return Set-Cookie on a failed login.
    jsonError(res, 401, 'AUTH_REQUIRED', 'invalid token')
    return
  }
  const sessionId = await w.authStore.createSession()
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': buildSetCookieHeader(sessionId),
  })
  res.end(JSON.stringify({ ok: true }))
}

export async function handleAuthLogout(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  if (!w.authStore) {
    jsonError(res, 500, 'INTERNAL', 'auth store unavailable')
    return
  }
  const cookie = readCookie(req, COOKIE_NAME_EXPORT)
  if (cookie) {
    await w.authStore.deleteSession(cookie)
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': buildClearCookieHeader(),
  })
  res.end(JSON.stringify({ ok: true }))
}

export function handleAuthCheck(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): void {
  if (!w.authStore) {
    jsonError(res, 500, 'INTERNAL', 'auth store unavailable')
    return
  }
  const cookie = readCookie(req, COOKIE_NAME_EXPORT)
  if (!cookie || !w.authStore.hasSession(cookie)) {
    jsonError(res, 401, 'AUTH_REQUIRED', 'no valid session')
    return
  }
  jsonOk(res, 200, { ok: true })
}
