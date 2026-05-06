import type { IncomingMessage, ServerResponse } from 'node:http'

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
const PATH_MESSAGES = '/api/sessions/:sessionKey/messages'

/**
 * Stable session id format: `sess_<epochMs>_<rand6>`.
 * Frozen now so Phase B (per-session folders) can use the id verbatim
 * as a folder name on disk without a destructive cutover.
 */
function generateSessionKey(): string {
  const rand = Math.random().toString(36).replace('.', '').slice(0, 6).padEnd(6, '0')
  return `sess_${Date.now()}_${rand}`
}

export function handleSessionsCreate(_req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const sessionKey = generateSessionKey()
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

/**
 * Hydration shape — matches the frontend ChatMessage so the UI can drop
 * straight into reducer state without replaying streaming events.
 */
interface ToolCallShape {
  id: string
  name: string
  args?: unknown
  result?: unknown
  status: 'pending' | 'running' | 'completed' | 'errored'
  durationMs?: number
  error?: string
}

interface ChatMessageShape {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  toolCalls: ToolCallShape[]
  streaming: boolean
  createdAt: number
  usage?: string
}

interface DbChatRow {
  id: string
  run_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | null
  tool_name: string | null
  tool_calls: string | null
  created_at: number
  tokens_in: number
  tokens_out: number
}

function formatUsage(input: number, output: number): string | undefined {
  if (input === 0 && output === 0) return undefined
  return `↓ ${input} ↑ ${output}`
}

function parseToolRow(row: DbChatRow): ToolCallShape | null {
  if (!row.tool_calls) return null
  try {
    const parsed = JSON.parse(row.tool_calls) as Partial<ToolCallShape>
    if (!parsed.id || !parsed.name) return null
    return {
      id: parsed.id,
      name: parsed.name,
      args: parsed.args,
      result: parsed.result,
      status: parsed.status ?? 'completed',
      durationMs: parsed.durationMs,
      error: parsed.error,
    }
  } catch {
    return null
  }
}

export async function handleSessionMessages(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  const params = matchPath(PATH_MESSAGES, parsePath(req.url))
  if (!params || !params.sessionKey) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown messages path')
    return
  }
  const sessionKey: string = params.sessionKey
  if (!w.sessions.has(sessionKey)) {
    jsonError(res, 404, 'UNKNOWN_SESSION', `session ${sessionKey} does not exist`)
    return
  }

  const messages: ChatMessageShape[] = []

  // Step 1: enumerate this session's runs from RunStore (filesystem-backed).
  // Each run's meta.json holds the user prompt + startedAt for ordering.
  const runs: Array<{ runId: string; prompt: string; startedAt: number }> = []
  // RunStore doesn't expose a list-by-session API yet — walk the filesystem.
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  let runDirs: string[] = []
  try {
    runDirs = await fs.readdir(w.runStore.root)
  } catch {
    runDirs = []
  }
  for (const runId of runDirs) {
    try {
      const metaRaw = await fs.readFile(path.join(w.runStore.root, runId, 'meta.json'), 'utf8')
      const meta = JSON.parse(metaRaw) as { sessionKey?: string; prompt?: string; startedAt?: number }
      if (meta.sessionKey === sessionKey && typeof meta.prompt === 'string') {
        runs.push({
          runId,
          prompt: meta.prompt,
          startedAt: typeof meta.startedAt === 'number' ? meta.startedAt : 0,
        })
      }
    } catch {
      // ignore broken/incomplete run dirs
    }
  }
  runs.sort((a, b) => a.startedAt - b.startedAt)

  // Step 2: for each run, append user msg, then walk DB rows in created_at order.
  if (!w.db) {
    // No DB → user prompts only.
    for (const r of runs) {
      messages.push({
        id: `user_${r.runId}`,
        role: 'user',
        text: r.prompt,
        toolCalls: [],
        streaming: false,
        createdAt: r.startedAt,
      })
    }
    jsonOk(res, 200, { messages })
    return
  }

  const stmt = w.db.prepare(`
    SELECT id, run_id, role, content, tool_name, tool_calls, created_at,
           tokens_in, tokens_out
      FROM chat_messages
     WHERE session_id = ? AND run_id = ?
     ORDER BY created_at ASC
  `)

  for (const r of runs) {
    messages.push({
      id: `user_${r.runId}`,
      role: 'user',
      text: r.prompt,
      toolCalls: [],
      streaming: false,
      createdAt: r.startedAt,
    })

    const rows = stmt.all(sessionKey, r.runId) as DbChatRow[]
    let pendingTools: ToolCallShape[] = []
    for (const row of rows) {
      if (row.role === 'tool') {
        const tc = parseToolRow(row)
        if (tc) pendingTools.push(tc)
        continue
      }
      if (row.role === 'assistant') {
        const usage = formatUsage(row.tokens_in, row.tokens_out)
        messages.push({
          id: row.id,
          role: 'assistant',
          text: row.content ?? '',
          toolCalls: pendingTools,
          streaming: false,
          createdAt: row.created_at,
          ...(usage ? { usage } : {}),
        })
        pendingTools = []
      }
    }
    // Tools that arrived without a trailing assistant — surface as a bare
    // assistant shell so the UI still shows them rather than dropping silently.
    if (pendingTools.length > 0) {
      messages.push({
        id: `orphan_${r.runId}`,
        role: 'assistant',
        text: '',
        toolCalls: pendingTools,
        streaming: false,
        createdAt: r.startedAt + 1,
      })
    }
  }

  jsonOk(res, 200, { messages })
}

export const SESSIONS_PATTERNS = {
  list: PATH_LIST,
  activeRun: PATH_ACTIVE_RUN,
  messages: PATH_MESSAGES,
}
