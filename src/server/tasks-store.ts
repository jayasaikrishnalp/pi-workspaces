import { randomUUID } from 'node:crypto'

import type { Db } from './db.js'

export type TaskStatus = 'triage' | 'todo' | 'ready' | 'running' | 'blocked' | 'done' | 'archived'
export type TaskSource = 'operator' | 'agent'

export interface Task {
  id: string
  title: string
  body: string | null
  status: TaskStatus
  priority: number
  source: TaskSource
  assignee_soul_id: string | null
  parent_task_id: string | null
  linked_job_id: string | null
  created_by: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  result: string | null
  idempotency_key: string | null
}

export class TaskError extends Error {
  constructor(public code: 'UNKNOWN_TASK' | 'INVALID_TRANSITION' | 'INTERNAL', message: string) {
    super(message)
    this.name = 'TaskError'
  }
}

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  triage:   ['todo', 'ready', 'archived'],
  todo:     ['ready', 'blocked', 'archived'],
  ready:    ['running', 'blocked', 'archived'],
  running:  ['done', 'blocked', 'archived'],
  blocked:  ['todo', 'ready', 'archived'],
  done:     ['archived'],
  archived: [],
}

export interface CreateTaskInput {
  title: string
  body?: string
  status?: TaskStatus
  priority?: number
  source?: TaskSource
  assigneeSoulId?: string
  parentTaskId?: string
  linkedJobId?: string
  createdBy?: string
  idempotencyKey?: string
}

export interface UpdateTaskPatch {
  title?: string
  body?: string
  status?: TaskStatus
  priority?: number
  assigneeSoulId?: string | null
  result?: string
}

export interface ListTasksFilters {
  status?: TaskStatus[]
  source?: TaskSource[]
  assigneeSoulId?: string
  limit?: number
}

export class TasksStore {
  constructor(private readonly db: Db) {}

  create(input: CreateTaskInput): Task {
    if (!input.title || typeof input.title !== 'string') {
      throw new TaskError('INTERNAL', 'title is required')
    }
    if (input.idempotencyKey) {
      const existing = this.db.prepare('SELECT * FROM tasks WHERE idempotency_key = ?').get(input.idempotencyKey) as Task | undefined
      if (existing) return existing
    }
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO tasks (
        id, title, body, status, priority, source,
        assignee_soul_id, parent_task_id, linked_job_id,
        created_by, created_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.body ?? null,
      input.status ?? 'triage',
      input.priority ?? 0,
      input.source ?? 'operator',
      input.assigneeSoulId ?? null,
      input.parentTaskId ?? null,
      input.linkedJobId ?? null,
      input.createdBy ?? null,
      now,
      input.idempotencyKey ?? null,
    )
    return this.get(id)!
  }

  get(id: string): Task | null {
    return (this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined) ?? null
  }

  list(filters: ListTasksFilters = {}): Task[] {
    const limit = Math.max(1, Math.min(500, filters.limit ?? 100))
    const where: string[] = []
    const params: unknown[] = []
    if (filters.status?.length) {
      where.push(`status IN (${filters.status.map(() => '?').join(',')})`)
      params.push(...filters.status)
    }
    if (filters.source?.length) {
      where.push(`source IN (${filters.source.map(() => '?').join(',')})`)
      params.push(...filters.source)
    }
    if (filters.assigneeSoulId) {
      where.push('assignee_soul_id = ?')
      params.push(filters.assigneeSoulId)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    return this.db.prepare(
      `SELECT * FROM tasks ${whereSql} ORDER BY status, priority ASC, created_at DESC LIMIT ?`,
    ).all(...params, limit) as Task[]
  }

  update(id: string, patch: UpdateTaskPatch): Task {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined
      if (!row) throw new TaskError('UNKNOWN_TASK', `unknown task ${id}`)
      let nextStatus: TaskStatus = row.status
      if (patch.status && patch.status !== row.status) {
        if (!ALLOWED[row.status].includes(patch.status)) {
          throw new TaskError('INVALID_TRANSITION', `${row.status} → ${patch.status} not allowed`)
        }
        nextStatus = patch.status
      }
      const now = Date.now()
      const startedAt = nextStatus === 'running' && row.started_at == null ? now : row.started_at
      const completedAt = (nextStatus === 'done' || nextStatus === 'archived') && row.completed_at == null ? now : row.completed_at
      this.db.prepare(`
        UPDATE tasks SET
          title = COALESCE(?, title),
          body = ?,
          status = ?,
          priority = COALESCE(?, priority),
          assignee_soul_id = ?,
          result = COALESCE(?, result),
          started_at = ?,
          completed_at = ?
        WHERE id = ?
      `).run(
        patch.title ?? null,
        patch.body !== undefined ? patch.body : row.body,
        nextStatus,
        patch.priority ?? null,
        patch.assigneeSoulId !== undefined ? patch.assigneeSoulId : row.assignee_soul_id,
        patch.result ?? null,
        startedAt,
        completedAt,
        id,
      )
    })
    tx()
    return this.get(id)!
  }

  archive(id: string): Task {
    return this.update(id, { status: 'archived' })
  }

  countByStatus(): Record<TaskStatus, number> {
    const out: Record<TaskStatus, number> = {
      triage: 0, todo: 0, ready: 0, running: 0, blocked: 0, done: 0, archived: 0,
    }
    const rows = this.db.prepare('SELECT status, COUNT(*) AS c FROM tasks GROUP BY status').all() as Array<{ status: TaskStatus; c: number }>
    for (const r of rows) out[r.status] = r.c
    return out
  }

  totalCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c
  }
}
