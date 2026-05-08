/**
 * WorkflowReviewRunner — autonomous post-run skill / memory review.
 *
 * Hooks WorkflowRunner.onRunComplete. Whenever a *user-triggered* run
 * terminates (status: completed | failed | cancelled), this runner
 * synthesises a transcript and starts a new run of REVIEW_WORKFLOW with
 * the L1 Review Agent. The agent decides whether anything from the
 * parent run is worth saving (as a skill via mcp__hive-self__skill_*
 * or as a memory entry via mcp__hive-self__memory_*).
 *
 * Recursion guard is declarative — review runs themselves use
 * REVIEW_WORKFLOW_ID and triggeredBy=REVIEW_TRIGGERED_BY, both of which
 * we explicitly skip in handleRunComplete().
 *
 * Failure mode: every step swallows errors. A bad review never bubbles
 * to the user — at worst, a console.error and no review run is written.
 */

import {
  REVIEW_WORKFLOW,
  REVIEW_WORKFLOW_ID,
  REVIEW_AGENT,
  REVIEW_TRIGGERED_BY,
} from './auto-review-defs.js'
import {
  CONSOLIDATE_WORKFLOW_ID,
  CONSOLIDATE_TRIGGERED_BY,
} from './kb-consolidator-defs.js'
import type { RunCompleteInfo, WorkflowRunner } from './workflow-runner.js'
import type { WorkflowRunsStore } from './workflow-runs-store.js'

const MAX_TRANSCRIPT_BYTES = 24_000

export interface WorkflowReviewRunnerDeps {
  /** The same WorkflowRunner the workspace uses for user-triggered runs.
   *  Reviews go through it too — they're just normal runs of a special
   *  workflow. */
  runner: WorkflowRunner
  /** Read-only access for hydrating the parent run's transcript. */
  store: WorkflowRunsStore
  /** Optional logger. Defaults to console.* with a `[review-runner]` prefix. */
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string, err?: unknown) => void }
}

const defaultLog = {
  info: (m: string) => console.info(`[review-runner] ${m}`),
  warn: (m: string) => console.warn(`[review-runner] ${m}`),
  error: (m: string, err?: unknown) => console.error(`[review-runner] ${m}`, err),
}

export class WorkflowReviewRunner {
  private readonly log: NonNullable<WorkflowReviewRunnerDeps['log']>

  constructor(private readonly deps: WorkflowReviewRunnerDeps) {
    this.log = deps.log ?? defaultLog
  }

  /** Wire as the WorkflowRunner's onRunComplete callback. */
  handleRunComplete = async (info: RunCompleteInfo): Promise<void> => {
    // Recursion guard #1: review runs themselves never trigger another review.
    if (info.workflowId === REVIEW_WORKFLOW_ID) return
    // Recursion guard #2 (defence in depth): triggeredBy may have been set
    // by another integration; ignore it as well.
    if (info.triggeredBy === REVIEW_TRIGGERED_BY) return
    // The kb-consolidator (Phase 5) is also background machinery —
    // operator-driven, distinct from the per-run review path. Its runs
    // should NOT trigger a Phase-3 review of themselves.
    if (info.workflowId === CONSOLIDATE_WORKFLOW_ID) return
    if (info.triggeredBy === CONSOLIDATE_TRIGGERED_BY) return
    // Don't review queued runs that crashed before any work happened.
    if (info.status !== 'completed' && info.status !== 'failed' && info.status !== 'cancelled') return

    try {
      const transcript = this.buildTranscript(info)
      await this.deps.runner.start({
        workflow: REVIEW_WORKFLOW,
        agents: [REVIEW_AGENT],
        triggeredBy: REVIEW_TRIGGERED_BY,
        inputs: {
          parent_run_id: info.runId,
          parent_workflow_id: info.workflowId,
          parent_workflow_name: info.workflowName ?? '(unknown)',
          transcript,
        },
      })
      this.log.info(`spawned review for run ${info.runId} (parent workflow: ${info.workflowId})`)
    } catch (err) {
      // ACTIVE_RUN means we're trying to start a second review run for the
      // same review-workflow. That happens when two parent runs finish
      // simultaneously — we serialise: the second one is dropped. This is
      // intentional, not an error.
      const code = (err as { code?: string }).code
      if (code === 'ACTIVE_RUN') {
        this.log.info(`review for ${info.runId} skipped — another review is already in flight`)
        return
      }
      this.log.error(`failed to spawn review for run ${info.runId}`, err)
    }
  }

  /**
   * Render the parent run as a structured text snapshot the review agent
   * can read. Truncates each step's output to keep the prompt under budget.
   */
  private buildTranscript(info: RunCompleteInfo): string {
    const parent = this.deps.store.getRun(info.runId)
    const steps = this.deps.store.listSteps(info.runId)
    const lines: string[] = []
    lines.push(`# Run snapshot`)
    lines.push(`workflow_id: ${info.workflowId}`)
    lines.push(`workflow_name: ${info.workflowName ?? '(unknown)'}`)
    lines.push(`run_id: ${info.runId}`)
    lines.push(`status: ${info.status}`)
    lines.push(`triggered_by: ${info.triggeredBy ?? '(none)'}`)
    if (parent?.started_at != null) {
      lines.push(`started_at: ${new Date(parent.started_at).toISOString()}`)
    }
    if (parent?.ended_at != null) {
      lines.push(`ended_at: ${new Date(parent.ended_at).toISOString()}`)
      if (parent.started_at != null) {
        lines.push(`duration_ms: ${parent.ended_at - parent.started_at}`)
      }
    }
    if (parent?.error) lines.push(`error: ${parent.error}`)
    lines.push('')
    lines.push(`# Steps (${steps.length})`)
    for (const s of steps) {
      lines.push('')
      lines.push(`## step_index=${s.step_index} step_id=${s.step_id ?? '?'} agent=${s.step_agent_id ?? '?'} status=${s.status}`)
      if (s.step_note) lines.push(`note: ${s.step_note}`)
      if (s.step_decision) lines.push(`decision: ${s.step_decision}`)
      if (s.step_next) lines.push(`next: ${s.step_next}`)
      if (s.error) lines.push(`error: ${s.error}`)
      if (s.output) {
        lines.push('output:')
        // Per-step truncation. Keep the head — early errors and the
        // "starting…" lines are typically more useful than tail noise.
        const trimmed = s.output.length > 4000 ? s.output.slice(0, 4000) + '\n…[truncated]' : s.output
        lines.push(trimmed)
      }
    }
    let out = lines.join('\n')
    // Final overall budget cap. The review agent is on claude-haiku-4-5
    // with a small context window — we don't want to send 100KB of step
    // output even if the run was huge.
    if (out.length > MAX_TRANSCRIPT_BYTES) {
      out = out.slice(0, MAX_TRANSCRIPT_BYTES) + '\n…[transcript truncated]'
    }
    return out
  }
}
