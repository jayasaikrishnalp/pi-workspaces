import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_BODY = 1_000_000 // 1MB; plenty for chat prompts.

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buf.length
    if (total > MAX_BODY) {
      const err = new Error('BODY_TOO_LARGE')
      ;(err as Error & { code?: string }).code = 'BODY_TOO_LARGE'
      throw err
    }
    chunks.push(buf)
  }
  if (total === 0) return null
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    const err = new Error('INVALID_JSON')
    ;(err as Error & { code?: string }).code = 'INVALID_JSON'
    throw err
  }
}

export function jsonOk(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function jsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body: Record<string, unknown> = { code, message, ts: Date.now() }
  if (details !== undefined) body.details = details
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
  res.end(JSON.stringify({ error: body }))
}

export function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }
}

export function sseWrite(
  res: ServerResponse,
  args: { id?: string; event?: string; data: unknown },
): boolean {
  let frame = ''
  if (args.id) frame += `id: ${args.id}\n`
  if (args.event) frame += `event: ${args.event}\n`
  frame += `data: ${typeof args.data === 'string' ? args.data : JSON.stringify(args.data)}\n\n`
  return res.write(frame)
}

export function sseComment(res: ServerResponse, comment: string): boolean {
  return res.write(`: ${comment}\n\n`)
}

export function parseQuery(reqUrl: string | undefined): URLSearchParams {
  const u = new URL(reqUrl ?? '/', 'http://_')
  return u.searchParams
}

export function parsePath(reqUrl: string | undefined): string {
  try {
    return new URL(reqUrl ?? '/', 'http://_').pathname
  } catch {
    return '/'
  }
}

/** Extract :paramName from a route pattern. Pattern uses `:name` and exact otherwise. */
export function matchPath(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const pp = pattern.split('/')
  const sp = path.split('/')
  if (pp.length !== sp.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pp.length; i++) {
    const a = pp[i]
    const b = sp[i]
    if (a.startsWith(':')) {
      params[a.slice(1)] = decodeURIComponent(b)
    } else if (a !== b) {
      return null
    }
  }
  return params
}
