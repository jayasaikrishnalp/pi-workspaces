import type { IncomingMessage } from 'node:http'

import type { AuthStore } from './auth-store.js'

const COOKIE_NAME = 'workspace_session'

/**
 * Public routes that the middleware lets through without a cookie.
 * - /api/health: liveness probe; deployment infra hits it before the operator
 *   has a token.
 * - /api/auth/login + /api/auth/check: needed to obtain or test a cookie.
 */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/check',
])

export interface AuthDecision {
  allowed: boolean
  /** When false, this is the reason for the 401. */
  reason?: 'missing_cookie' | 'invalid_cookie' | 'no_session'
}

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path)
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  const parts = raw.split(';')
  for (const p of parts) {
    const eq = p.indexOf('=')
    if (eq < 0) continue
    const k = p.slice(0, eq).trim()
    if (k !== name) continue
    return p.slice(eq + 1).trim()
  }
  return null
}

export function checkAuth(req: IncomingMessage, path: string, store: AuthStore | null): AuthDecision {
  if (process.env.PI_WORKSPACE_AUTH_DISABLED === '1') return { allowed: true }
  if (isPublicPath(path)) return { allowed: true }
  if (!store) return { allowed: false, reason: 'invalid_cookie' }
  const cookie = readCookie(req, COOKIE_NAME)
  if (!cookie) return { allowed: false, reason: 'missing_cookie' }
  if (!store.hasSession(cookie)) return { allowed: false, reason: 'no_session' }
  return { allowed: true }
}

export function buildSetCookieHeader(sessionId: string): string {
  // `Path=/` so cookie applies to the whole API; `HttpOnly` so JS can't read.
  // `SameSite=Lax` blocks cross-site POSTs but allows top-level navigation.
  // `Max-Age` is unset — session cookies last until browser close OR they get
  // explicitly cleared. The server-side store also tracks them.
  return `${COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Lax; Path=/`
}

export function buildClearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

export const COOKIE_NAME_EXPORT = COOKIE_NAME
