/**
 * Workflow run endpoints.
 *
 *   POST  /api/workflows/:name/run            kick off a new run
 *   POST  /api/workflows/:name/run/:runId/cancel
 *   GET   /api/workflows/:name/runs           list recent runs
 *   GET   /api/workflows/:name/runs/:runId    single run + steps
 *   GET   /api/workflows/:name/run/:runId/events  SSE stream
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { jsonError, jsonOk, matchPath, parsePath } from '../server/http-helpers.js'
import { RunnerError } from '../server/workflow-runner.js'
import type { Wiring } from '../server/wiring.js'

export const WORKFLOW_RUN_START_PATTERN  = '/api/workflows/:name/run'
export const WORKFLOW_RUN_CANCEL_PATTERN = '/api/workflows/:name/run/:runId/cancel'
export const WORKFLOW_RUN_EVENTS_PATTERN = '/api/workflows/:name/run/:runId/events'
export const WORKFLOW_RUNS_LIST_PATTERN  = '/api/workflows/:name/runs'
export const WORKFLOW_RUN_DETAIL_PATTERN = '/api/workflows/:name/runs/:runId'

function ensureFeature(res: ServerResponse, w: Wiring): w is Wiring & {
  workflowRunsStore: NonNullable<Wiring['workflowRunsStore']>
  workflowRunner: NonNullable<Wiring['workflowRunner']>
  workflowRunBuses: NonNullable<Wiring['workflowRunBuses']>
} {
  if (!w.workflowRunsStore || !w.workflowRunner || !w.workflowRunBuses) {
    jsonError(res, 503, 'WORKFLOW_RUNS_DISABLED', 'workflow runs require a SQLite database; not available in this wiring')
    return false
  }
  return true
}

export async function handleWorkflowRunStart(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(WORKFLOW_RUN_START_PATTERN, parsePath(req.url))
  const name = params?.name
  if (!name) { jsonError(res, 400, 'BAD_REQUEST', 'name required'); return }
  if (!ensureFeature(res, w)) return
  try {
    const runId = await w.workflowRunner.start(name, { triggeredBy: 'operator' })
    jsonOk(res, 202, { runId })
  } catch (err) {
    if (err instanceof RunnerError) {
      const status = err.code === 'ACTIVE_RUN' ? 409 : err.code === 'NO_STEPS' ? 400 : 500
      jsonError(res, status, err.code, err.message, err.details)
      return
    }
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}

export async function handleWorkflowRunCancel(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(WORKFLOW_RUN_CANCEL_PATTERN, parsePath(req.url))
  const runId = params?.runId
  if (!runId) { jsonError(res, 400, 'BAD_REQUEST', 'runId required'); return }
  if (!ensureFeature(res, w)) return
  w.workflowRunner.cancel(runId)
  jsonOk(res, 202, { ok: true })
}

export async function handleWorkflowRunsList(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(WORKFLOW_RUNS_LIST_PATTERN, parsePath(req.url))
  const name = params?.name
  if (!name) { jsonError(res, 400, 'BAD_REQUEST', 'name required'); return }
  if (!ensureFeature(res, w)) return
  jsonOk(res, 200, { runs: w.workflowRunsStore.listRuns(name, 20) })
}

export async function handleWorkflowRunDetail(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(WORKFLOW_RUN_DETAIL_PATTERN, parsePath(req.url))
  const runId = params?.runId
  if (!runId) { jsonError(res, 400, 'BAD_REQUEST', 'runId required'); return }
  if (!ensureFeature(res, w)) return
  const run = w.workflowRunsStore.getRun(runId)
  if (!run) { jsonError(res, 404, 'NOT_FOUND', 'run not found'); return }
  const steps = w.workflowRunsStore.listSteps(runId)
  jsonOk(res, 200, { run, steps })
}

export async function handleWorkflowRunEvents(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(WORKFLOW_RUN_EVENTS_PATTERN, parsePath(req.url))
  const runId = params?.runId
  if (!runId) { jsonError(res, 400, 'BAD_REQUEST', 'runId required'); return }
  if (!ensureFeature(res, w)) return

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(`: workflow run events for ${runId}\n\n`)

  const bus = w.workflowRunBuses.getOrCreate(runId)
  // Replay buffered history first so a late client can still reconstruct state.
  for (const evt of bus.history()) {
    res.write(`event: ${evt.kind}\ndata: ${JSON.stringify(evt)}\n\n`)
  }
  const unsubscribe = bus.subscribe((evt) => {
    res.write(`event: ${evt.kind}\ndata: ${JSON.stringify(evt)}\n\n`)
    if (evt.kind === 'run.end') {
      // Give the client a moment to read the terminal event then close.
      setTimeout(() => { try { res.end() } catch { /* ignore */ } }, 100)
    }
  })

  // Heartbeat every 15s so reverse proxies don't drop the stream.
  const heartbeat = setInterval(() => {
    try { res.write(`: hb ${Date.now()}\n\n`) } catch { /* ignore */ }
  }, 15_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
}
