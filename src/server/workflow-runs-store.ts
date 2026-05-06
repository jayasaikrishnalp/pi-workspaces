/**
 * WorkflowRunsStore — persistence for workflow_runs + workflow_step_runs.
 * Sequential v1: no parallel steps, no retries. The runner mutates these
 * rows as steps progress; the SSE bus emits live events.
 */
import type { Db } from './db.js'

export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type WorkflowStepStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped'

export interface WorkflowRunRow {
  id: string
  workflow: string
  status: WorkflowRunStatus
  started_at: number
  ended_at: number | null
  triggered_by: string | null
  step_count: number
  step_done: number
  error: string | null
}

export interface WorkflowStepRunRow {
  run_id: string
  step_index: number
  step_kind: 'skill' | 'workflow'
  step_ref: string
  status: WorkflowStepStatus
  started_at: number | null
  ended_at: number | null
  output: string | null
  error: string | null
}

const OUTPUT_CAP = 4096

export class WorkflowRunsStore {
  constructor(private db: Db) {}

  createRun(input: {
    id: string
    workflow: string
    triggeredBy: string | null
    steps: Array<{ kind: 'skill' | 'workflow'; ref: string }>
  }): WorkflowRunRow {
    const now = Date.now()
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO workflow_runs (id, workflow, status, started_at, triggered_by, step_count)
         VALUES (?, ?, 'queued', ?, ?, ?)`,
      ).run(input.id, input.workflow, now, input.triggeredBy, input.steps.length)
      const stmt = this.db.prepare(
        `INSERT INTO workflow_step_runs (run_id, step_index, step_kind, step_ref, status)
         VALUES (?, ?, ?, ?, 'queued')`,
      )
      input.steps.forEach((s, i) => stmt.run(input.id, i, s.kind, s.ref))
    })
    tx()
    return this.getRun(input.id)!
  }

  getRun(id: string): WorkflowRunRow | null {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as WorkflowRunRow | undefined
    return row ?? null
  }

  listRuns(workflow: string, limit = 20): WorkflowRunRow[] {
    return this.db.prepare(
      'SELECT * FROM workflow_runs WHERE workflow = ? ORDER BY started_at DESC LIMIT ?',
    ).all(workflow, limit) as WorkflowRunRow[]
  }

  listSteps(runId: string): WorkflowStepRunRow[] {
    return this.db.prepare(
      'SELECT * FROM workflow_step_runs WHERE run_id = ? ORDER BY step_index ASC',
    ).all(runId) as WorkflowStepRunRow[]
  }

  /** Returns null when no run is currently in flight for the given workflow. */
  activeRun(workflow: string): WorkflowRunRow | null {
    const row = this.db.prepare(
      "SELECT * FROM workflow_runs WHERE workflow = ? AND status IN ('queued','running') ORDER BY started_at DESC LIMIT 1",
    ).get(workflow) as WorkflowRunRow | undefined
    return row ?? null
  }

  setRunStatus(id: string, status: WorkflowRunStatus, opts: { error?: string | null; stepDone?: number } = {}): void {
    const fields: string[] = ['status = ?']
    const params: unknown[] = [status]
    if (status === 'running') {
      // no ended_at change
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      fields.push('ended_at = ?'); params.push(Date.now())
    }
    if (opts.error !== undefined) {
      fields.push('error = ?'); params.push(opts.error)
    }
    if (typeof opts.stepDone === 'number') {
      fields.push('step_done = ?'); params.push(opts.stepDone)
    }
    params.push(id)
    this.db.prepare(`UPDATE workflow_runs SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  }

  startStep(runId: string, index: number): void {
    this.db.prepare(
      `UPDATE workflow_step_runs SET status = 'running', started_at = ? WHERE run_id = ? AND step_index = ?`,
    ).run(Date.now(), runId, index)
  }

  finishStep(runId: string, index: number, opts: { status: 'completed' | 'failed' | 'skipped'; output?: string; error?: string }): void {
    const out = opts.output != null ? opts.output.slice(0, OUTPUT_CAP) : null
    this.db.prepare(
      `UPDATE workflow_step_runs SET status = ?, ended_at = ?, output = ?, error = ?
       WHERE run_id = ? AND step_index = ?`,
    ).run(opts.status, Date.now(), out, opts.error ?? null, runId, index)
  }

  appendStepOutput(runId: string, index: number, chunk: string): void {
    // Coalesce — keep at most OUTPUT_CAP bytes total.
    const cur = this.db.prepare(
      'SELECT output FROM workflow_step_runs WHERE run_id = ? AND step_index = ?',
    ).get(runId, index) as { output: string | null } | undefined
    const next = ((cur?.output ?? '') + chunk).slice(-OUTPUT_CAP)
    this.db.prepare(
      'UPDATE workflow_step_runs SET output = ? WHERE run_id = ? AND step_index = ?',
    ).run(next, runId, index)
  }
}
