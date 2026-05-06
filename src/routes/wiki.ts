/**
 * /api/wiki/* — read endpoints over WikiStore + the search-wiki tool.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { jsonError, jsonOk, readJsonBody } from '../server/http-helpers.js'
import { searchWiki, SEARCH_WIKI_TOOL } from '../server/tools/search-wiki.js'
import type { Wiring } from '../server/wiring.js'

export const WIKI_STATS_PATH = '/api/wiki/stats'
export const WIKI_DOCS_PATH = '/api/wiki/docs'
export const WIKI_DOC_PATH = '/api/wiki/doc'
export const WIKI_SEARCH_PATH = '/api/wiki/search'
export const TOOLS_SEARCH_WIKI_PATH = '/api/tools/search-wiki'

export async function handleWikiStats(_req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  if (!w.wikiStore) {
    jsonOk(res, 200, { configured: false, count: 0, lastIngestAt: null, root: null })
    return
  }
  jsonOk(res, 200, {
    configured: true,
    root: w.wikiRoot ?? null,
    count: w.wikiStore.count(),
    lastIngestAt: w.wikiStore.lastIngestAt(),
  })
}

export async function handleWikiDocs(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  if (!w.wikiStore) {
    jsonOk(res, 200, { docs: [] })
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const prefix = url.searchParams.get('prefix') ?? undefined
  const limit = numParam(url.searchParams.get('limit'), 100)
  const offset = numParam(url.searchParams.get('offset'), 0)
  jsonOk(res, 200, { docs: w.wikiStore.list({ prefix, limit, offset }) })
}

export async function handleWikiDoc(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  if (!w.wikiStore) {
    jsonError(res, 404, 'NOT_FOUND', 'wiki not configured')
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const p = url.searchParams.get('path')
  if (!p) {
    jsonError(res, 400, 'BAD_REQUEST', 'path query parameter required')
    return
  }
  const doc = w.wikiStore.get(p)
  if (!doc) {
    jsonError(res, 404, 'NOT_FOUND', `wiki doc not found: ${p}`)
    return
  }
  jsonOk(res, 200, doc)
}

export async function handleWikiSearch(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  if (!w.wikiStore) {
    jsonOk(res, 200, { results: [] })
    return
  }
  let body: unknown
  try { body = await readJsonBody(req) } catch (err) {
    jsonError(res, 400, 'BAD_REQUEST', (err as Error).message)
    return
  }
  const { q, limit } = (body ?? {}) as { q?: unknown; limit?: unknown }
  if (typeof q !== 'string' || q.trim().length === 0) {
    jsonError(res, 400, 'BAD_REQUEST', 'q must be a non-empty string')
    return
  }
  const cap = typeof limit === 'number' ? limit : 5
  jsonOk(res, 200, searchWiki(w.wikiStore, q, cap))
}

export async function handleSearchWikiTool(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  if (!w.wikiStore) {
    jsonOk(res, 200, { results: [], source: 'pipeline-information/wiki', query: '' })
    return
  }
  let body: unknown
  try { body = await readJsonBody(req) } catch (err) {
    jsonError(res, 400, 'BAD_REQUEST', (err as Error).message)
    return
  }
  const { query, limit } = (body ?? {}) as { query?: unknown; limit?: unknown }
  if (typeof query !== 'string' || query.trim().length === 0) {
    jsonError(res, 400, 'BAD_REQUEST', 'query must be a non-empty string')
    return
  }
  const cap = typeof limit === 'number' ? limit : 5
  jsonOk(res, 200, searchWiki(w.wikiStore, query, cap))
}

export { SEARCH_WIKI_TOOL }

function numParam(s: string | null, dflt: number): number {
  if (!s) return dflt
  const n = Number(s)
  return Number.isFinite(n) ? n : dflt
}
