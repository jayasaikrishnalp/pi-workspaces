import type { IncomingMessage, ServerResponse } from 'node:http'

import { jsonError, jsonOk, matchPath, parsePath, readJsonBody } from '../server/http-helpers.js'
import { TasksStore, TaskError, type TaskSource, type TaskStatus } from '../server/tasks-store.js'
import type { Wiring } from '../server/wiring.js'

export const TASKS_PATH = '/api/tasks'
export const TASKS_DETAIL_PATTERN = '/api/tasks/:id'

const ALL_STATUSES: TaskStatus[] = ['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived']
const ALL_SOURCES: TaskSource[] = ['operator', 'agent']

function requireDb(res: ServerResponse, w: Wiring): TasksStore | null {
  if (!w.db) { jsonError(res, 500, 'NO_DB', 'database not initialized'); return null }
  return new TasksStore(w.db)
}

export function handleTasksList(req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const store = requireDb(res, w); if (!store) return
  const url = new URL(req.url ?? '/', 'http://localhost')
  const status = url.searchParams.get('status')?.split(',').map((s) => s.trim()).filter((s): s is TaskStatus => ALL_STATUSES.includes(s as TaskStatus))
  const source = url.searchParams.get('source')?.split(',').map((s) => s.trim()).filter((s): s is TaskSource => ALL_SOURCES.includes(s as TaskSource))
  const assignee = url.searchParams.get('assignee') ?? undefined
  const limit = parseInt(url.searchParams.get('limit') ?? '', 10) || 100
  jsonOk(res, 200, { tasks: store.list({ status, source, assigneeSoulId: assignee, limit }) })
}

export async function handleTasksCreate(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const store = requireDb(res, w); if (!store) return
  let body: unknown
  try { body = await readJsonBody(req) } catch (err) { jsonError(res, 400, 'BAD_REQUEST', (err as Error).message); return }
  if (!body || typeof body !== 'object') { jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object'); return }
  const obj = body as Record<string, unknown>
  if (typeof obj.title !== 'string' || obj.title.length === 0) { jsonError(res, 400, 'BAD_REQUEST', 'title is required'); return }
  if (obj.status !== undefined && !ALL_STATUSES.includes(obj.status as TaskStatus)) { jsonError(res, 400, 'BAD_REQUEST', `invalid status`); return }
  if (obj.source !== undefined && !ALL_SOURCES.includes(obj.source as TaskSource)) { jsonError(res, 400, 'BAD_REQUEST', `invalid source`); return }
  try {
    const task = store.create({
      title: obj.title,
      body: typeof obj.body === 'string' ? obj.body : undefined,
      status: (obj.status as TaskStatus) ?? undefined,
      priority: typeof obj.priority === 'number' ? obj.priority : undefined,
      source: (obj.source as TaskSource) ?? undefined,
      assigneeSoulId: typeof obj.assignee_soul_id === 'string' ? obj.assignee_soul_id : undefined,
      parentTaskId: typeof obj.parent_task_id === 'string' ? obj.parent_task_id : undefined,
      linkedJobId: typeof obj.linked_job_id === 'string' ? obj.linked_job_id : undefined,
      idempotencyKey: typeof obj.idempotency_key === 'string' ? obj.idempotency_key : undefined,
    })
    jsonOk(res, 201, task)
  } catch (err) {
    if (err instanceof TaskError) { jsonError(res, 500, err.code, err.message); return }
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}

export function handleTasksRead(req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const store = requireDb(res, w); if (!store) return
  const params = matchPath(TASKS_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.id) { jsonError(res, 404, 'NOT_FOUND', 'unknown task path'); return }
  const task = store.get(params.id)
  if (!task) { jsonError(res, 404, 'UNKNOWN_TASK', `task ${params.id} not found`); return }
  jsonOk(res, 200, task)
}

export async function handleTasksUpdate(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const store = requireDb(res, w); if (!store) return
  const params = matchPath(TASKS_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.id) { jsonError(res, 404, 'NOT_FOUND', 'unknown task path'); return }
  let body: unknown
  try { body = await readJsonBody(req) } catch (err) { jsonError(res, 400, 'BAD_REQUEST', (err as Error).message); return }
  if (!body || typeof body !== 'object') { jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object'); return }
  const obj = body as Record<string, unknown>
  if (obj.status !== undefined && !ALL_STATUSES.includes(obj.status as TaskStatus)) { jsonError(res, 400, 'BAD_REQUEST', `invalid status`); return }
  try {
    const task = store.update(params.id, {
      title: typeof obj.title === 'string' ? obj.title : undefined,
      body: typeof obj.body === 'string' ? obj.body : undefined,
      status: (obj.status as TaskStatus) ?? undefined,
      priority: typeof obj.priority === 'number' ? obj.priority : undefined,
      assigneeSoulId: 'assignee_soul_id' in obj
        ? (typeof obj.assignee_soul_id === 'string' ? obj.assignee_soul_id : null)
        : undefined,
      result: typeof obj.result === 'string' ? obj.result : undefined,
    })
    jsonOk(res, 200, task)
  } catch (err) {
    if (err instanceof TaskError) {
      const status = err.code === 'UNKNOWN_TASK' ? 404 : err.code === 'INVALID_TRANSITION' ? 409 : 500
      jsonError(res, status, err.code, err.message)
      return
    }
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}

export function handleTasksDelete(req: IncomingMessage, res: ServerResponse, w: Wiring): void {
  const store = requireDb(res, w); if (!store) return
  const params = matchPath(TASKS_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.id) { jsonError(res, 404, 'NOT_FOUND', 'unknown task path'); return }
  try {
    const task = store.archive(params.id)
    jsonOk(res, 200, task)
  } catch (err) {
    if (err instanceof TaskError) {
      const status = err.code === 'UNKNOWN_TASK' ? 404 : err.code === 'INVALID_TRANSITION' ? 409 : 500
      jsonError(res, status, err.code, err.message)
      return
    }
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}
