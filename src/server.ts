/**
 * pi-workspace-server
 *
 * Stage 0: HTTP listener with /api/health and structured 404/405.
 * Stage 2: pi-rpc bridge + chat event bus + run store + sessions/runs/send-stream/chat-events routes.
 *
 * Spec: openspec/specs/{server,health}/spec.md and openspec/changes/add-pi-rpc-bridge/specs/**.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import url from 'node:url'

import {
  jsonError as jsonErrorHelper,
  matchPath,
  parsePath as parsePathHelper,
} from './server/http-helpers.js'
import { getWiring, type Wiring } from './server/wiring.js'
import {
  handleSessionsCreate,
  handleSessionsList,
  handleActiveRun,
} from './routes/sessions.js'
import { handleSendStream, SEND_STREAM_PATH } from './routes/send-stream.js'
import { handleChatEvents, CHAT_EVENTS_PATH } from './routes/chat-events.js'
import { handleRunEvents, handleRunAbort, RUNS_EVENTS_PATTERN, RUNS_ABORT_PATTERN } from './routes/runs.js'
import { handleKbGraph, handleKbEvents, KB_GRAPH_PATH, KB_EVENTS_PATH } from './routes/kb.js'
import {
  handleConfluenceSearch,
  handleConfluencePage,
  CONFLUENCE_SEARCH_PATH,
  CONFLUENCE_PAGE_PATTERN,
} from './routes/confluence.js'
import {
  handleSkillsCreate,
  handleKbSkillGet,
  SKILLS_CREATE_PATH,
  KB_SKILL_GET_PATTERN,
} from './routes/skills.js'
import {
  handleAuthLogin,
  handleAuthLogout,
  handleAuthCheck,
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_CHECK_PATH,
} from './routes/auth.js'
import { handleProbe, PROBE_PATH } from './routes/probe.js'
import { checkAuth } from './server/auth-middleware.js'

export const VERSION = '0.1.0'
export const DEFAULT_PORT = 8766

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

interface Route {
  method: Method
  pattern: string
  handler: (req: IncomingMessage, res: ServerResponse, w: Wiring) => void | Promise<void>
}

const ROUTES: Route[] = [
  { method: 'GET', pattern: '/api/health', handler: handleHealth },

  // Stage 2 routes
  { method: 'POST', pattern: '/api/sessions', handler: handleSessionsCreate },
  { method: 'GET', pattern: '/api/sessions', handler: handleSessionsList },
  { method: 'GET', pattern: '/api/sessions/:sessionKey/active-run', handler: handleActiveRun },
  { method: 'POST', pattern: SEND_STREAM_PATH, handler: handleSendStream },
  { method: 'GET', pattern: CHAT_EVENTS_PATH, handler: handleChatEvents },
  { method: 'GET', pattern: RUNS_EVENTS_PATTERN, handler: handleRunEvents },
  { method: 'POST', pattern: RUNS_ABORT_PATTERN, handler: handleRunAbort },

  // Stage 4 routes — KB graph + filesystem-event channel (separate bus).
  { method: 'GET', pattern: KB_GRAPH_PATH, handler: handleKbGraph },
  { method: 'GET', pattern: KB_EVENTS_PATH, handler: handleKbEvents },

  // Stage 5 routes — Confluence search + page fetch (10-point hardened).
  { method: 'POST', pattern: CONFLUENCE_SEARCH_PATH, handler: handleConfluenceSearch },
  { method: 'GET', pattern: CONFLUENCE_PAGE_PATTERN, handler: handleConfluencePage },

  // Stage 6 routes — skill creation + read.
  { method: 'POST', pattern: SKILLS_CREATE_PATH, handler: handleSkillsCreate },
  { method: 'GET', pattern: KB_SKILL_GET_PATTERN, handler: handleKbSkillGet },

  // Stage 7 routes — auth + capability probe.
  { method: 'POST', pattern: AUTH_LOGIN_PATH, handler: handleAuthLogin },
  { method: 'POST', pattern: AUTH_LOGOUT_PATH, handler: handleAuthLogout },
  { method: 'GET', pattern: AUTH_CHECK_PATH, handler: handleAuthCheck },
  { method: 'GET', pattern: PROBE_PATH, handler: handleProbe },
]

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, version: VERSION }))
}

function jsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  jsonErrorHelper(res, status, code, message, details, extraHeaders)
}

function parsePath(reqUrl: string | undefined): string {
  return parsePathHelper(reqUrl)
}

function dispatch(req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const reqPath = parsePath(req.url)
  const method = (req.method ?? 'GET') as Method

  // Defense-in-depth: a request like `/api/confluence/page/../../etc/passwd`
  // gets normalized by the URL parser to `/api/etc/passwd` and would 404
  // generically — but the locked spec requires 400 INVALID_PAGE_ID for any
  // path-traversal attempt under that prefix. Inspect the raw URL.
  const rawUrl = req.url ?? ''
  if (
    method === 'GET' &&
    rawUrl.startsWith('/api/confluence/page/') &&
    (rawUrl.includes('..') || rawUrl.includes('%2f') || rawUrl.includes('%2F') || rawUrl.includes('%5c') || rawUrl.includes('%5C'))
  ) {
    jsonError(res, 400, 'INVALID_PAGE_ID', 'pageId must be numeric', {
      raw: rawUrl,
    })
    return
  }

  // Stage 7: cookie-gated auth middleware. /api/health and the auth endpoints
  // are public; everything else requires a valid session cookie. Tests bypass
  // with PI_WORKSPACE_AUTH_DISABLED=1.
  const authDecision = checkAuth(req, reqPath, w.authStore ?? null)
  if (!authDecision.allowed) {
    jsonError(res, 401, 'AUTH_REQUIRED', `auth required (${authDecision.reason ?? 'no_cookie'})`)
    return
  }

  // Find every route whose pattern matches this path.
  const matched = ROUTES.map((r) => ({ route: r, params: matchPath(r.pattern, reqPath) }))
    .filter((m) => m.params != null) as Array<{ route: Route; params: Record<string, string> }>

  if (matched.length === 0) {
    jsonError(res, 404, 'NOT_FOUND', `Unknown path: ${reqPath}`, {
      path: reqPath,
      method,
    })
    return
  }
  const exact = matched.find((m) => m.route.method === method)
  if (!exact) {
    const allowed = matched.map((m) => m.route.method)
    jsonError(
      res,
      405,
      'METHOD_NOT_ALLOWED',
      `Method ${method} not allowed on ${reqPath}`,
      { path: reqPath, method, allowed },
      { Allow: allowed.join(', ') },
    )
    return
  }
  Promise.resolve(exact.route.handler(req, res, w)).catch((err) => {
    console.error('[server] handler threw:', err)
    if (!res.headersSent) {
      jsonError(res, 500, 'INTERNAL_ERROR', (err as Error).message ?? 'unknown')
    } else {
      try {
        res.end()
      } catch {
        // ignore
      }
    }
  })
}

function startServer(port: number, wiring?: Wiring): http.Server {
  const w = wiring ?? getWiring()
  const server = http.createServer((req, res) => dispatch(req, res, w))
  server.on('error', (err) => {
    const e = err as NodeJS.ErrnoException
    console.error(`[server] fatal error: ${e.code ?? ''} ${err.message} (port=${port})`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    const addr = server.address()
    const boundPort = typeof addr === 'object' && addr ? addr.port : port
    console.log(`[server] listening on http://127.0.0.1:${boundPort} (v${VERSION})`)
  })
  return server
}

function installShutdown(server: http.Server): void {
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] received ${signal}; shutting down...`)
    server.close(() => {
      console.log('[server] closed cleanly')
      process.exit(0)
    })
    setTimeout(() => {
      console.error('[server] graceful shutdown timed out; forcing exit')
      process.exit(0)
    }, 5000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false
  try {
    const here = url.fileURLToPath(import.meta.url)
    const entry = path.resolve(process.argv[1])
    return here === entry
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  const portRaw = process.env.PORT ?? String(DEFAULT_PORT)
  if (!/^\d+$/.test(portRaw)) {
    console.error(`[server] invalid PORT=${JSON.stringify(portRaw)}; must be a non-negative integer`)
    process.exit(1)
  }
  const port = Number(portRaw)
  if (port < 0 || port > 65535) {
    console.error(`[server] invalid PORT=${portRaw}; out of range`)
    process.exit(1)
  }
  const server = startServer(port)
  installShutdown(server)
}

export { startServer, dispatch, jsonError, handleHealth, parsePath, isEntrypoint }
