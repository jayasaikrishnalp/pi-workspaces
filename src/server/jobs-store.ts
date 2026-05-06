import { randomUUID } from 'node:crypto'

import type { Db } from './db.js'

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type JobSource = 'operator' | 'agent' | 'cron'

export interface Job {
  id: string
  soul_id: string | null
  agent_id: string | null
  run_id: string | null
  session_id: string | null
  status: JobStatus
  title: string | null
  source: JobSource
  created_at: number
  started_at: number | null
  completed_at: number | null
  summary: string | null
  error: string | null
}

export class JobError extends Error {
  constructor(public code: 'UNKNOWN_JOB' | 'INVALID_TRANSITION' | 'INTERNAL', message: string) {
    super(message)
    this.name = 'JobError'
  }
}

const ALLOWED: Record<JobStatus, JobStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

export interface CreateJobInput {
  soulId?: string
  agentId?: string
  runId?: string
  sessionId?: string
  title?: string
  source?: JobSource
}

export class JobsStore {
  constructor(private readonly db: Db) {}

  create(input: CreateJobInput): Job {
    const id = randomUUID()
    const now = Date.now()
    const source: JobSource = input.source ?? 'operator'
    this.db.prepare(`
      INSERT INTO jobs (id, soul_id, agent_id, run_id, session_id, status, title, source, created_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(
      id,
      input.soulId ?? null,
      input.agentId ?? null,
      input.runId ?? null,
      input.sessionId ?? null,
      input.title ?? null,
      source,
      now,
    )
    return this.get(id)!
  }

  get(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined
    return row ?? null
  }

  list(opts: { status?: JobStatus[]; limit?: number } = {}): Job[] {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
    if (opts.status && opts.status.length > 0) {
      const placeholders = opts.status.map(() => '?').join(',')
      return this.db.prepare(
        `SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`,
      ).all(...opts.status, limit) as Job[]
    }
    return this.db.prepare(
      'SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as Job[]
  }

  /**
   * Transition `id` from any of `from` to `to`. The state-machine guard runs
   * inside an immediate transaction; if the current status is not in `from`
   * (i.e. another writer already moved it), the call throws INVALID_TRANSITION
   * with the actual current status in the message.
   */
  transition(id: string, to: JobStatus, opts: { error?: string; summary?: string } = {}): Job {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined
      if (!row) throw new JobError('UNKNOWN_JOB', `unknown job ${id}`)
      const allowed = ALLOWED[row.status]
      if (!allowed.includes(to)) {
        throw new JobError('INVALID_TRANSITION', `${row.status} → ${to} not allowed (job ${id})`)
      }
      const now = Date.now()
      const startedAt = to === 'running' && row.started_at == null ? now : row.started_at
      const completedAt = (to === 'completed' || to === 'failed' || to === 'cancelled') ? now : row.completed_at
      this.db.prepare(`
        UPDATE jobs SET status = ?, started_at = ?, completed_at = ?, error = ?, summary = ?
        WHERE id = ?
      `).run(
        to,
        startedAt,
        completedAt,
        opts.error ?? row.error,
        opts.summary ?? row.summary,
        id,
      )
    })
    tx()
    return this.get(id)!
  }

  cancel(id: string, reason?: string): Job {
    const current = this.get(id)
    if (!current) throw new JobError('UNKNOWN_JOB', `unknown job ${id}`)
    if (current.status === 'cancelled' || current.status === 'completed' || current.status === 'failed') {
      throw new JobError('INVALID_TRANSITION', `cannot cancel a ${current.status} job`)
    }
    return this.transition(id, 'cancelled', { error: reason ?? 'cancelled by operator' })
  }

  countByStatus(): Record<JobStatus, number> {
    const out: Record<JobStatus, number> = {
      queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0,
    }
    const rows = this.db.prepare('SELECT status, COUNT(*) AS c FROM jobs GROUP BY status').all() as Array<{ status: JobStatus; c: number }>
    for (const r of rows) out[r.status] = r.c
    return out
  }

  totalCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number }).c
  }
}
