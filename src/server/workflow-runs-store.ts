/**
 * WorkflowRunsStore — persistence for workflow_runs + workflow_step_runs.
 *
 * v1 (migration 005) stored linear { kind: 'skill'|'workflow', ref } steps.
 * v2 (migration 006) extends each step row with agent-driven metadata:
 *   step_id, step_agent_id, step_note, step_branches (JSON), step_decision,
 *   step_next, pi_run_id. Existing readers keep working because we still
 *   write step_kind = 'agent' and step_ref = agentId for v2 rows.
 *
 * The runner mutates these rows as steps progress; the SSE bus emits live
 * events.
 */
import type { Db } from './db.js'

export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type WorkflowStepStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped'

export interface WorkflowRunRow {
  id: string
  workflow: string
  workflow_name: string | null
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
  step_kind: 'skill' | 'workflow' | 'agent'
  step_ref: string
  status: WorkflowStepStatus
  started_at: number | null
  ended_at: number | null
  output: string | null
  error: string | null
  // v2 additions (nullable for back-compat with v1 rows):
  step_id: string | null
  step_agent_id: string | null
  step_note: string | null
  step_branches: string | null
  step_decision: string | null
  step_next: string | null
  pi_run_id: string | null
}

/** Per-step input shape accepted by createRun. */
export interface AgentStepInput {
  /** Stable step id (e.g. "triage"). */
  id: string
  /** Agent id reference (e.g. "l1-triage-agent"). */
  agentId: string
  /** Free-text instruction for this step. */
  note?: string
  /** Decision-routed branches: { 'approve': 'next-step-id', 'no-approve': 'end' }. */
  branches?: Record<string, string>
  /** Explicit non-default next-step id, or 'end'. */
  next?: string
}

const OUTPUT_CAP = 4096

export class WorkflowRunsStore {
  constructor(private db: Db) {}

  /** v2: create a run from agent-driven steps. */
  createRun(input: {
    id: string
    /** Stable workflow id (e.g. "wf-server-deletion"). */
    workflow: string
    /** Human-friendly workflow name (optional; falls back to workflow id). */
    workflowName?: string
    triggeredBy: string | null
    steps: AgentStepInput[]
  }): WorkflowRunRow {
    const now = Date.now()
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO workflow_runs (id, workflow, workflow_name, status, started_at, triggered_by, step_count)
         VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
      ).run(input.id, input.workflow, input.workflowName ?? null, now, input.triggeredBy, input.steps.length)
      const stmt = this.db.prepare(
        `INSERT INTO workflow_step_runs (
            run_id, step_index, step_kind, step_ref, status,
            step_id, step_agent_id, step_note, step_branches, step_next
         ) VALUES (?, ?, 'agent', ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      input.steps.forEach((s, i) =>
        stmt.run(
          input.id, i, s.agentId,
          s.id, s.agentId, s.note ?? null,
          s.branches ? JSON.stringify(s.branches) : null,
          s.next ?? null,
        ),
      )
    })
    tx()
    return this.getRun(input.id)!
  }

  getRun(id: string): WorkflowRunRow | null {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as WorkflowRunRow | undefined
    return row ?? null
  }

  /** List recent runs of a workflow id (or all when workflow is undefined). */
  listRuns(workflow: string | undefined, limit = 20): WorkflowRunRow[] {
    if (workflow == null) {
      return this.db.prepare(
        'SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?',
      ).all(limit) as WorkflowRunRow[]
    }
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

  startStep(runId: string, index: number, opts: { piRunId?: string } = {}): void {
    if (opts.piRunId) {
      this.db.prepare(
        `UPDATE workflow_step_runs SET status = 'running', started_at = ?, pi_run_id = ?
         WHERE run_id = ? AND step_index = ?`,
      ).run(Date.now(), opts.piRunId, runId, index)
    } else {
      this.db.prepare(
        `UPDATE workflow_step_runs SET status = 'running', started_at = ? WHERE run_id = ? AND step_index = ?`,
      ).run(Date.now(), runId, index)
    }
  }

  finishStep(
    runId: string,
    index: number,
    opts: {
      status: 'completed' | 'failed' | 'skipped'
      output?: string
      error?: string
      decision?: string | null
      next?: string | null
    },
  ): void {
    const out = opts.output != null ? opts.output.slice(-OUTPUT_CAP) : null
    this.db.prepare(
      `UPDATE workflow_step_runs SET
         status = ?, ended_at = ?, output = ?, error = ?,
         step_decision = COALESCE(?, step_decision),
         step_next     = COALESCE(?, step_next)
       WHERE run_id = ? AND step_index = ?`,
    ).run(
      opts.status, Date.now(), out, opts.error ?? null,
      opts.decision ?? null, opts.next ?? null,
      runId, index,
    )
  }

  /** Persist a decision token + the resolved next step id for a step. */
  setStepDecision(runId: string, index: number, decision: string | null, next: string | null): void {
    this.db.prepare(
      `UPDATE workflow_step_runs SET step_decision = ?, step_next = ? WHERE run_id = ? AND step_index = ?`,
    ).run(decision, next, runId, index)
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
