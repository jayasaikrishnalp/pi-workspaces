import type { IncomingMessage, ServerResponse } from 'node:http'

import { jsonError, jsonOk, matchPath, parsePath } from '../server/http-helpers.js'
import { JobsStore, JobError, type JobStatus } from '../server/jobs-store.js'
import type { Wiring } from '../server/wiring.js'

export const JOBS_PATH = '/api/jobs'
export const JOBS_DETAIL_PATTERN = '/api/jobs/:id'
export const JOBS_CANCEL_PATTERN = '/api/jobs/:id/cancel'

const ALL_STATUSES: JobStatus[] = ['queued', 'running', 'completed', 'failed', 'cancelled']

function requireDb(res: ServerResponse, w: Wiring): JobsStore | null {
  if (!w.db) {
    jsonError(res, 500, 'NO_DB', 'database not initialized')
    return null
  }
  return new JobsStore(w.db)
}

export function handleJobsList(req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const store = requireDb(res, w); if (!store) return
  const url = new URL(req.url ?? '/', 'http://localhost')
  const csv = url.searchParams.get('status')
  const statuses = csv
    ? csv.split(',').map((s) => s.trim()).filter((s): s is JobStatus => ALL_STATUSES.includes(s as JobStatus))
    : undefined
  const limit = parseInt(url.searchParams.get('limit') ?? '', 10) || 50
  jsonOk(res, 200, { jobs: store.list({ status: statuses, limit }) })
}

export function handleJobsRead(req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const store = requireDb(res, w); if (!store) return
  const params = matchPath(JOBS_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.id) { jsonError(res, 404, 'NOT_FOUND', 'unknown job path'); return }
  const job = store.get(params.id)
  if (!job) { jsonError(res, 404, 'UNKNOWN_JOB', `job ${params.id} not found`); return }
  jsonOk(res, 200, job)
}

export function handleJobsCancel(req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const store = requireDb(res, w); if (!store) return
  const params = matchPath(JOBS_CANCEL_PATTERN, parsePath(req.url))
  if (!params || !params.id) { jsonError(res, 404, 'NOT_FOUND', 'unknown job path'); return }
  try {
    const job = store.cancel(params.id)
    // Best-effort: also abort the underlying run via the bridge.
    if (job.run_id) {
      try { w.bridge?.abort?.(job.run_id) } catch { /* ignore */ }
    }
    jsonOk(res, 200, job)
  } catch (err) {
    if (err instanceof JobError) {
      const status = err.code === 'UNKNOWN_JOB' ? 404 : err.code === 'INVALID_TRANSITION' ? 409 : 500
      jsonError(res, status, err.code, err.message)
      return
    }
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}
