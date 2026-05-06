import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { jsonError, jsonOk, matchPath, parsePath, readJsonBody } from '../server/http-helpers.js'
import { TerminalStore } from '../server/terminal-store.js'
import { runCommand } from '../server/terminal-runner.js'
import type { Wiring } from '../server/wiring.js'

export const TERMINAL_EXEC_PATH = '/api/terminal/exec'
export const TERMINAL_EXECUTIONS_PATH = '/api/terminal/executions'
export const TERMINAL_EXECUTIONS_DETAIL_PATTERN = '/api/terminal/executions/:id'

const MAX_COMMAND_LEN = 4096
const MAX_TIMEOUT_MS = 300_000
const DEFAULT_TIMEOUT_MS = 60_000

function requireDb(res: ServerResponse, w: Wiring): TerminalStore | null {
  if (!w.db) { jsonError(res, 500, 'NO_DB', 'database not initialized'); return null }
  return new TerminalStore(w.db)
}

export async function handleTerminalExec(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const store = requireDb(res, w); if (!store) return
  let body: unknown
  try { body = await readJsonBody(req) } catch (err) {
    jsonError(res, 400, 'BAD_REQUEST', (err as Error).message); return
  }
  if (!body || typeof body !== 'object') {
    jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object'); return
  }
  const obj = body as Record<string, unknown>
  if (typeof obj.command !== 'string' || obj.command.length === 0) {
    jsonError(res, 400, 'BAD_REQUEST', 'command is required and must be a non-empty string'); return
  }
  if (obj.command.length > MAX_COMMAND_LEN) {
    jsonError(res, 400, 'COMMAND_TOO_LONG', `command exceeds ${MAX_COMMAND_LEN} characters`); return
  }
  const cwd = typeof obj.cwd === 'string' && obj.cwd.length > 0 ? obj.cwd : w.workspaceRoot
  const timeoutMs = typeof obj.timeoutMs === 'number' ? obj.timeoutMs : DEFAULT_TIMEOUT_MS
  if (timeoutMs > MAX_TIMEOUT_MS) {
    jsonError(res, 400, 'TIMEOUT_TOO_LONG', `timeoutMs exceeds ${MAX_TIMEOUT_MS}`); return
  }
  if (timeoutMs <= 0) {
    jsonError(res, 400, 'BAD_REQUEST', 'timeoutMs must be positive'); return
  }

  const id = randomUUID()
  store.start(id, obj.command, cwd)
  const result = await runCommand({ command: obj.command, cwd, timeoutMs }, w.spawnBash!)
  store.complete(id, result)
  jsonOk(res, 200, {
    id,
    status: result.status,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  })
}

export function handleTerminalExecutionsList(req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const store = requireDb(res, w); if (!store) return
  const url = new URL(req.url ?? '/', 'http://localhost')
  const limit = parseInt(url.searchParams.get('limit') ?? '', 10) || 50
  const beforeRaw = url.searchParams.get('before')
  const before = beforeRaw ? parseInt(beforeRaw, 10) : undefined
  jsonOk(res, 200, { executions: store.list({ limit, before: Number.isFinite(before) ? before : undefined }) })
}

export function handleTerminalExecutionsRead(req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const store = requireDb(res, w); if (!store) return
  const params = matchPath(TERMINAL_EXECUTIONS_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.id) { jsonError(res, 404, 'NOT_FOUND', 'unknown terminal path'); return }
  const row = store.get(params.id)
  if (!row) { jsonError(res, 404, 'UNKNOWN_EXECUTION', `execution ${params.id} not found`); return }
  jsonOk(res, 200, row)
}
