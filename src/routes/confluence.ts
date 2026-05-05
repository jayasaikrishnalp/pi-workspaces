import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  jsonError,
  jsonOk,
  matchPath,
  parsePath,
  parseQuery,
  readJsonBody,
} from '../server/http-helpers.js'
import type { Wiring } from '../server/wiring.js'
import { ConfluenceError } from '../server/confluence-client.js'

export const CONFLUENCE_SEARCH_PATH = '/api/confluence/search'
export const CONFLUENCE_PAGE_PATTERN = '/api/confluence/page/:pageId'

export async function handleConfluenceSearch(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  if (!w.confluence) {
    jsonError(res, 503, 'CONFLUENCE_UNAVAILABLE', 'Confluence client is not configured')
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    const code = (err as Error & { code?: string }).code ?? 'BAD_REQUEST'
    jsonError(res, 400, code, (err as Error).message)
    return
  }
  if (!body || typeof body !== 'object') {
    jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object')
    return
  }
  const { query, limit } = body as Record<string, unknown>
  try {
    const hits = await w.confluence.search({ query: query as string, limit: limit as number | undefined })
    jsonOk(res, 200, { hits })
  } catch (err) {
    if (err instanceof ConfluenceError) {
      const { status, code } = mapErr(err)
      jsonError(res, status, code, err.message)
      return
    }
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}

export async function handleConfluencePage(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  if (!w.confluence) {
    jsonError(res, 503, 'CONFLUENCE_UNAVAILABLE', 'Confluence client is not configured')
    return
  }
  const params = matchPath(CONFLUENCE_PAGE_PATTERN, parsePath(req.url))
  if (!params || !params.pageId) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown confluence page path')
    return
  }
  const pageId: string = params.pageId
  // Strict /^\d+$/ validation lives in the client; route does an early-reject
  // so unsafe characters never reach Atlassian (defense-in-depth).
  if (!/^\d+$/.test(pageId)) {
    jsonError(res, 400, 'INVALID_PAGE_ID', 'pageId must be numeric', { pageId })
    return
  }
  const q = parseQuery(req.url)
  const maxCharsRaw = q.get('maxChars')
  let maxChars: number | undefined
  if (maxCharsRaw != null) {
    const parsed = Number(maxCharsRaw)
    if (!Number.isInteger(parsed)) {
      jsonError(res, 400, 'INVALID_INPUT', 'maxChars must be an integer')
      return
    }
    // Spec is clamp, not reject: clamp to [256, 16000].
    maxChars = Math.min(16_000, Math.max(256, parsed))
  }
  try {
    const page = await w.confluence.getPage(pageId, maxChars)
    jsonOk(res, 200, page)
  } catch (err) {
    if (err instanceof ConfluenceError) {
      const { status, code } = mapErr(err)
      jsonError(res, status, code, err.message)
      return
    }
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}

function mapErr(err: ConfluenceError): { status: number; code: string } {
  switch (err.code) {
    case 'INVALID_INPUT':
      return { status: 400, code: 'INVALID_INPUT' }
    case 'INVALID_PAGE_ID':
      return { status: 400, code: 'INVALID_PAGE_ID' }
    case 'INVALID_BASE_URL':
      return { status: 503, code: 'CONFLUENCE_UNAVAILABLE' }
    case 'AUTH_REQUIRED':
      return { status: 401, code: 'AUTH_REQUIRED' }
    case 'FORBIDDEN':
      return { status: 403, code: 'FORBIDDEN' }
    case 'RATE_LIMITED':
      return { status: 429, code: 'RATE_LIMITED' }
    case 'TIMEOUT':
      return { status: 504, code: 'TIMEOUT' }
    case 'EXTERNAL_API_ERROR':
      return { status: 502, code: 'EXTERNAL_API_ERROR' }
    default:
      return { status: 500, code: 'INTERNAL' }
  }
}
