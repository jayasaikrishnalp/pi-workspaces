import type { IncomingMessage } from 'node:http'

import type { AuthStore } from './auth-store.js'

const COOKIE_NAME = 'workspace_session'

/**
 * Internal token header — child processes the workspace itself spawned
 * (pi via the bridge, mcp-bridge extension, etc.) present this to bypass
 * the cookie-based auth so they can call /api/mcp/* and /api/secrets
 * without having to do an interactive login. The token is generated at
 * boot in wiring.ts and passed to the pi child via env (WORKSPACE_INTERNAL_TOKEN).
 * NEVER log this token; never persist it to disk; rotate every server start.
 */
export const INTERNAL_TOKEN_HEADER = 'x-workspace-internal-token'

/** Set at boot via setInternalToken(); auth-middleware checks it on every request. */
let INTERNAL_TOKEN: string | null = null
export function setInternalToken(token: string | null): void { INTERNAL_TOKEN = token }
export function getInternalToken(): string | null { return INTERNAL_TOKEN }

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
  // Internal token bypass — children we spawned (pi, mcp-bridge) present the
  // header. Constant-time compare to avoid timing oracles.
  if (INTERNAL_TOKEN) {
    const presented = req.headers[INTERNAL_TOKEN_HEADER]
    if (typeof presented === 'string' && timingSafeEqual(presented, INTERNAL_TOKEN)) {
      return { allowed: true }
    }
  }
  if (!store) return { allowed: false, reason: 'invalid_cookie' }
  const cookie = readCookie(req, COOKIE_NAME)
  if (!cookie) return { allowed: false, reason: 'missing_cookie' }
  if (!store.hasSession(cookie)) return { allowed: false, reason: 'no_session' }
  return { allowed: true }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
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
