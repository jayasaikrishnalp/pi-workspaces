/**
 * Tiny HTTP wrapper around the Hive workspace's own /api endpoints.
 *
 * - Reads the workspace port from `~/.pi-workspace/server.port` (the same
 *   file the mcp-bridge extension uses).
 * - Reads `WORKSPACE_INTERNAL_TOKEN` from env at every call (no caching, so
 *   a server restart that rotates the token lands on the next request).
 * - Returns parsed JSON or throws HiveError with the API's error code.
 *
 * No process state — every call resolves PORT + TOKEN fresh.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PORT_FILE = path.join(os.homedir(), '.pi-workspace', 'server.port')
const INTERNAL_TOKEN_HEADER = 'x-workspace-internal-token'

export class HiveError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message)
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, string | undefined>
}

function readPort(): number {
  let raw: string
  try {
    raw = fs.readFileSync(PORT_FILE, 'utf8').trim()
  } catch (err) {
    throw new HiveError(
      'NO_WORKSPACE_PORT',
      `${PORT_FILE} not readable — is the workspace running? (${(err as Error).message})`,
    )
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n > 65_535) {
    throw new HiveError('NO_WORKSPACE_PORT', `${PORT_FILE} contains "${raw}" — not a valid port`)
  }
  return n
}

function readToken(): string {
  const tok = process.env.WORKSPACE_INTERNAL_TOKEN
  if (typeof tok !== 'string' || tok.length === 0) {
    throw new HiveError(
      'NO_INTERNAL_TOKEN',
      'WORKSPACE_INTERNAL_TOKEN not set in env — this MCP server must run as a child of the Hive workspace',
    )
  }
  return tok
}

export async function hiveRequest<T = unknown>(pathStr: string, opts: RequestOptions = {}): Promise<T> {
  const port = readPort()
  const token = readToken()
  const url = new URL(`http://127.0.0.1:${port}${pathStr.startsWith('/') ? pathStr : '/' + pathStr}`)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null && v !== '') url.searchParams.set(k, v)
    }
  }
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      [INTERNAL_TOKEN_HEADER]: token,
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  }
  let res: Response
  try {
    res = await fetch(url.toString(), init)
  } catch (err) {
    throw new HiveError('NETWORK', `network error to ${url.host}: ${(err as Error).message}`)
  }
  const text = await res.text()
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  if (!res.ok) {
    const errBody = (parsed && typeof parsed === 'object' ? (parsed as { error?: { code?: string; message?: string } }).error : undefined)
    const code = errBody?.code ?? `HTTP_${res.status}`
    const msg = errBody?.message ?? res.statusText
    throw new HiveError(code, `${code}: ${msg} (on ${opts.method ?? 'GET'} ${url.pathname})`, res.status)
  }
  return parsed as T
}
