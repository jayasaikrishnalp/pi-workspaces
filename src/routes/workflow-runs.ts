/**
 * Workflow run endpoints (v2 — agent-driven YAML workflows).
 *
 *   POST  /api/workflow-runs                     body: { workflow, agents, triggeredBy?, inputs? }
 *                                                → 202 { runId }
 *                                                inputs: Record<string,string> — values the user
 *                                                typed in the start-prompt panel; rendered into
 *                                                each step's WORKFLOW INPUTS section.
 *   POST  /api/workflow-runs/:runId/cancel       → 202 { ok: true }
 *   GET   /api/workflow-runs/:runId              → { run, steps }
 *   GET   /api/workflow-runs/:runId/events       → SSE stream
 *   GET   /api/workflow-runs?workflowId=…        → { runs }   (workflowId optional)
 *
 * Workflow + agent definitions live in the browser (localStorage); the client
 * sends the resolved blob with each POST so the server has everything inline.
 * No workflow CRUD on the server.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { jsonError, jsonOk, matchPath, parsePath, readJsonBody } from '../server/http-helpers.js'
import { RunnerError, type Workflow, type AgentDef } from '../server/workflow-runner.js'
import type { Wiring } from '../server/wiring.js'

export const WORKFLOW_RUN_START_PATTERN  = '/api/workflow-runs'
export const WORKFLOW_RUN_CANCEL_PATTERN = '/api/workflow-runs/:runId/cancel'
export const WORKFLOW_RUN_EVENTS_PATTERN = '/api/workflow-runs/:runId/events'
export const WORKFLOW_RUNS_LIST_PATTERN  = '/api/workflow-runs'
export const WORKFLOW_RUN_DETAIL_PATTERN = '/api/workflow-runs/:runId'

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

function validateBody(body: unknown): { workflow: Workflow; agents: AgentDef[]; triggeredBy: string | undefined; inputs: Record<string, string> | undefined } | string {
  if (!body || typeof body !== 'object') return 'body must be a JSON object'
  const o = body as Record<string, unknown>
  if (!o.workflow || typeof o.workflow !== 'object') return 'workflow object required'
  if (!Array.isArray(o.agents)) return 'agents array required'
  const wf = o.workflow as Record<string, unknown>
  if (typeof wf.id !== 'string' || wf.id.length === 0) return 'workflow.id required'
  if (typeof wf.name !== 'string' || wf.name.length === 0) return 'workflow.name required'
  if (!Array.isArray(wf.steps) || wf.steps.length === 0) return 'workflow.steps must be a non-empty array'
  for (let i = 0; i < (wf.steps as unknown[]).length; i++) {
    const s = (wf.steps as unknown[])[i] as Record<string, unknown>
    if (typeof s.id !== 'string' || s.id.length === 0) return `steps[${i}].id required`
    if (typeof s.agentId !== 'string' || s.agentId.length === 0) return `steps[${i}].agentId required`
  }
  for (let i = 0; i < (o.agents as unknown[]).length; i++) {
    const a = (o.agents as unknown[])[i] as Record<string, unknown>
    if (typeof a.id !== 'string' || a.id.length === 0) return `agents[${i}].id required`
    if (typeof a.name !== 'string') return `agents[${i}].name required`
    if (typeof a.prompt !== 'string') return `agents[${i}].prompt required`
  }
  // Read workflow inputs (the values the user typed in the start-prompt
  // panel). Only string keys with string values are accepted; anything
  // else is silently dropped so a malformed client can't poison the run.
  let inputs: Record<string, string> | undefined
  if (o.inputs && typeof o.inputs === 'object' && !Array.isArray(o.inputs)) {
    const cleaned: Record<string, string> = {}
    for (const [k, v] of Object.entries(o.inputs as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string') cleaned[k] = v
    }
    if (Object.keys(cleaned).length > 0) inputs = cleaned
  }
  return {
    workflow: o.workflow as unknown as Workflow,
    agents: o.agents as unknown as AgentDef[],
    triggeredBy: typeof o.triggeredBy === 'string' ? o.triggeredBy : undefined,
    inputs,
  }
}

export async function handleWorkflowRunStart(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  if (!ensureFeature(res, w)) return
  let body: unknown
  try { body = await readJsonBody(req) }
  catch (err) { jsonError(res, 400, 'BAD_REQUEST', (err as Error).message); return }
  const validated = validateBody(body)
  if (typeof validated === 'string') {
    jsonError(res, 400, 'BAD_REQUEST', validated)
    return
  }
  try {
    const runId = await w.workflowRunner.start({
      workflow: validated.workflow,
      agents: validated.agents,
      triggeredBy: validated.triggeredBy ?? 'operator',
      inputs: validated.inputs,
    })
    jsonOk(res, 202, { runId })
  } catch (err) {
    if (err instanceof RunnerError) {
      const status =
        err.code === 'ACTIVE_RUN' ? 409 :
        err.code === 'NO_STEPS' || err.code === 'BAD_WORKFLOW' ||
        err.code === 'MISSING_AGENT' || err.code === 'BAD_NEXT' ||
        err.code === 'BAD_BRANCH' ? 400 : 500
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
  if (!ensureFeature(res, w)) return
  const url = new URL(req.url ?? '/', 'http://localhost')
  const workflowId = url.searchParams.get('workflowId') ?? undefined
  jsonOk(res, 200, { runs: w.workflowRunsStore.listRuns(workflowId, 20) })
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
  for (const evt of bus.history()) {
    res.write(`event: ${evt.kind}\ndata: ${JSON.stringify(evt)}\n\n`)
  }
  const unsubscribe = bus.subscribe((evt) => {
    res.write(`event: ${evt.kind}\ndata: ${JSON.stringify(evt)}\n\n`)
    if (evt.kind === 'run.end') {
      setTimeout(() => { try { res.end() } catch { /* ignore */ } }, 100)
    }
  })

  const heartbeat = setInterval(() => {
    try { res.write(`: hb ${Date.now()}\n\n`) } catch { /* ignore */ }
  }, 15_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
  })
}
