/**
 * pi-workspace-server — Stage 0
 * HTTP listener with /api/health and structured 404/405.
 *
 * Spec: openspec/changes/add-server-skeleton/specs/{server,health}/spec.md
 * Locked spec: cloudops-workspace-spec.md §2.6 (error shape) and §3 (API surface).
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import url from 'node:url'

export const VERSION = '0.1.0'
export const DEFAULT_PORT = 8766

interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void
}

const ROUTES: Route[] = [
  { method: 'GET', path: '/api/health', handler: handleHealth },
]

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, version: VERSION }))
}

/**
 * Emit a structured error matching cloudops-workspace-spec.md §2.6:
 *   { error: { code, message, details?, ts } }
 * `details` is optional in the payload but always allowed.
 */
function jsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  const body: { code: string; message: string; details?: Record<string, unknown>; ts: number } = {
    code,
    message,
    ts: Date.now(),
  }
  if (details !== undefined) body.details = details
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify({ error: body }))
}

/**
 * Robust path extraction: handles relative paths, absolute-form request
 * targets ("http://host/path"), trailing queries, and malformed URLs.
 */
function parsePath(reqUrl: string | undefined): string {
  try {
    return new URL(reqUrl ?? '/', 'http://_').pathname
  } catch {
    return '/'
  }
}

function dispatch(req: IncomingMessage, res: ServerResponse): void {
  const reqPath = parsePath(req.url)
  const method = req.method ?? 'GET'
  const matchesPath = ROUTES.filter((r) => r.path === reqPath)

  if (matchesPath.length === 0) {
    jsonError(res, 404, 'NOT_FOUND', `Unknown path: ${reqPath}`, {
      path: reqPath,
      method,
    })
    return
  }
  const matchExact = matchesPath.find((r) => r.method === method)
  if (!matchExact) {
    const allowed = matchesPath.map((r) => r.method)
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
  matchExact.handler(req, res)
}

function startServer(port: number): http.Server {
  const server = http.createServer(dispatch)
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

/**
 * Robust entry-point detection: compare resolved file paths, not URL strings.
 * Handles paths with spaces, symlinks, and platform path encoding.
 */
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
