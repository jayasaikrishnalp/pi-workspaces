import type { IncomingMessage, ServerResponse } from 'node:http'

import { jsonError, jsonOk } from '../server/http-helpers.js'
import { buildIntelligence } from '../server/dashboard-intelligence.js'
import type { Wiring } from '../server/wiring.js'

export const DASHBOARD_INTELLIGENCE_PATH = '/api/dashboard/intelligence'

const MIN_WINDOW = 1
const MAX_WINDOW = 90

export function handleDashboardIntelligence(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): void {
  if (!w.db) { jsonError(res, 500, 'NO_DB', 'database not initialized'); return }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const raw = url.searchParams.get('window') ?? '7d'
  const m = /^(\d+)d$/.exec(raw)
  const days = m ? parseInt(m[1]!, 10) : NaN
  if (!Number.isFinite(days) || days < MIN_WINDOW || days > MAX_WINDOW) {
    jsonError(res, 400, 'INVALID_WINDOW',
      `window must match /^(\\d+)d$/ in [${MIN_WINDOW},${MAX_WINDOW}]; got ${JSON.stringify(raw)}`)
    return
  }
  try {
    jsonOk(res, 200, buildIntelligence(w.db, { windowDays: days }))
  } catch (err) {
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}
