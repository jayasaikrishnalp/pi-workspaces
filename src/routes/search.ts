import type { IncomingMessage, ServerResponse } from 'node:http'

import { jsonError, jsonOk } from '../server/http-helpers.js'
import { sanitizeFtsQuery, search, type SearchKind } from '../server/search.js'
import type { Wiring } from '../server/wiring.js'

export const SEARCH_PATH = '/api/search'

const ALL_KINDS: SearchKind[] = ['skill', 'agent', 'workflow', 'memory', 'soul', 'chat']

export function handleSearch(req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const q = url.searchParams.get('q') ?? ''
  if (!sanitizeFtsQuery(q)) {
    jsonError(res, 400, 'INVALID_QUERY', 'q must be a non-empty string with searchable content')
    return
  }
  const kindCsv = url.searchParams.get('kind')
  const kinds: SearchKind[] = kindCsv
    ? kindCsv.split(',').map((s) => s.trim()).filter((s): s is SearchKind => (ALL_KINDS as string[]).includes(s))
    : ALL_KINDS
  if (kinds.length === 0) {
    jsonError(res, 400, 'INVALID_KIND', 'no recognized kinds in filter')
    return
  }
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 20)) : 20

  if (!w.db) {
    jsonError(res, 500, 'NO_DB', 'database not initialized')
    return
  }
  const results = search(w.db, q, { kinds: new Set(kinds), limit })
  jsonOk(res, 200, { results, query: q, kinds })
}
