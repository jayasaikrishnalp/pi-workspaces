/**
 * WorkflowRunner v2 — agent-driven, branching pipelines.
 *
 * Every step references an Agent (from the client roster). For each step:
 *   1. Mark step running, emit `step.start`.
 *   2. Compose the prompt = agent.prompt + workflow context + previous-step
 *      output + (optional) decision-token trailer when the step has branches.
 *   3. Drive the configured `AgentStepExecutor` to run the prompt. The default
 *      executor (`SimulatedAgentExecutor`) emits a deterministic stub output
 *      so tests can drive the runner without spawning pi. Commit 3 wires up
 *      the `PiBridgeStepExecutor`.
 *   4. Parse a DECISION token from the output if the step has branches; route
 *      to branches[decision], else step.next, else the next list element.
 *   5. Mark step completed/failed, persist output + decision + next, emit
 *      `step.end`.
 *
 * Failure halts the run. Cancellation is cooperative — the runner checks the
 * cancel flag between steps and emits `run.end status=cancelled`.
 */
import { randomUUID } from 'node:crypto'

import type { WorkflowRunsStore } from './workflow-runs-store.js'
import type { WorkflowRunBusRegistry, WorkflowRunBus } from './workflow-run-bus.js'

/* ===== Public types ===== */

export interface WorkflowStep {
  id: string
  agentId: string
  note?: string
  next?: string
  branches?: Record<string, string>
}

export interface Workflow {
  id: string
  name: string
  task?: string
  steps: WorkflowStep[]
}

export interface AgentDef {
  id: string
  name: string
  kind: string
  role?: string
  model: string
  skills: string[]
  prompt: string
}

/** Per-step context the executor receives. */
export interface StepContext {
  workflow: Workflow
  agent: AgentDef
  step: WorkflowStep
  workflowRunId: string
  stepIndex: number
  /** Composed prompt (agent.prompt + workflow/task/note + prevOutput + decision trailer). */
  prompt: string
  /** True when the step has branches and the executor should emit a DECISION line. */
  needsDecision: boolean
}

export interface ExecutorHooks {
  emitChunk: (chunk: string) => void
  shouldCancel: () => boolean
}

export interface AgentStepExecutor {
  execute(ctx: StepContext, hooks: ExecutorHooks): Promise<{
    status: 'completed' | 'failed' | 'cancelled'
    output: string
    error?: string
    /** Optional bridge run id (if executed via pi) — persisted for traceability. */
    piRunId?: string
  }>
}

export interface RunnerStartArgs {
  workflow: Workflow
  agents: AgentDef[]
  triggeredBy?: string
  /** Initial values for workflow.inputs — keyed by input field name. The
   *  runner injects these into every step's prompt as a WORKFLOW INPUTS
   *  section so agents can reference e.g. `ritm_number` directly. */
  inputs?: Record<string, string>
}

export interface WorkflowRunnerDeps {
  store: WorkflowRunsStore
  bus: WorkflowRunBusRegistry
  /** Executor used when the runner runs each step. Tests inject a simulated one;
   *  commit 3 swaps in the real pi-bridge executor. */
  executor?: AgentStepExecutor
  /** Optional fire-after-run hook. Called once for EVERY terminal status
   *  (completed / failed / cancelled). Errors thrown here are caught and
   *  logged; they never surface to the user. The auto-skill-review system
   *  uses this to spawn a follow-up review run. */
  onRunComplete?: (info: RunCompleteInfo) => void | Promise<void>
}

export interface RunCompleteInfo {
  runId: string
  workflowId: string
  workflowName: string | null
  status: 'completed' | 'failed' | 'cancelled'
  triggeredBy: string | null
}

/* ===== Decision token parser ===== */

/**
 * Walk the output backwards line-by-line; return the first DECISION token
 * we hit. Token format: `DECISION: <token>` on its own line.
 *   token = [a-z0-9][a-z0-9_-]*  (case-folded to lowercase on return)
 *
 * Returns null when no valid DECISION line is present.
 */
export function parseDecisionToken(text: string): string | null {
  if (!text) return null
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^DECISION:\s*([a-z0-9][a-z0-9_-]*)\s*$/i.exec(lines[i]!)
    if (m) return m[1]!.toLowerCase()
  }
  return null
}

/* ===== Routing logic ===== */

/** Pick the next step id given a step, its parsed decision (if any), the full
 *  steps list, and the current step index. Pure function — no side effects. */
export function chooseNext(
  step: WorkflowStep,
  decision: string | null,
  steps: WorkflowStep[],
  index: number,
): string {
  // 1. Branches with a matching decision → route there.
  if (step.branches && decision && step.branches[decision]) {
    return step.branches[decision]
  }
  // 2. Explicit next override.
  if (step.next) return step.next
  // 3. Default: next list element, else 'end'.
  return steps[index + 1]?.id ?? 'end'
}

/* ===== Prompt composer ===== */

const PREV_OUTPUT_TAIL_BYTES = 4096

export function composePrompt(
  workflow: Workflow,
  step: WorkflowStep,
  agent: AgentDef,
  prevOutput: string,
  /** Workflow-level inputs the user typed in the start-prompt panel. Rendered
   *  as a WORKFLOW INPUTS section so the agent can reference each by name
   *  even when the workflow has no explicit bindings. */
  inputs?: Record<string, string>,
): string {
  const branchKeys = step.branches ? Object.keys(step.branches) : []
  const decisionTrailer = branchKeys.length > 0
    ? `\n\n---\nYou MUST end your response with a single line in this exact format:\n  DECISION: <token>\nwhere <token> is one of: ${branchKeys.join(' | ')}\n\nThe DECISION line is the ONLY way the workflow knows which branch to take. ` +
      `Place it on its own line, lowercase, no quotes, no extra punctuation.`
    : ''

  const prevSection = prevOutput.trim()
    ? `\nPREVIOUS STEP OUTPUT:\n${prevOutput.trim().slice(-PREV_OUTPUT_TAIL_BYTES)}\n`
    : ''

  // Render workflow inputs as `key=value` lines. Agents reference these by
  // exact field name (e.g. ritm_number, host, region). Empty/whitespace-only
  // values are skipped so the agent doesn't pattern-match a blank string as
  // "field present".
  const inputLines = inputs
    ? Object.entries(inputs)
        .filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
        .map(([k, v]) => `  ${k} = ${v}`)
    : []
  const inputsSection = inputLines.length > 0
    ? `\nWORKFLOW INPUTS (typed by the user when starting this run — use these as the source of truth):\n${inputLines.join('\n')}\n`
    : ''

  return [
    `You are ${agent.name}.`,
    '',
    agent.prompt,
    '',
    '---',
    `WORKFLOW: ${workflow.name}`,
    workflow.task ? `TASK: ${workflow.task}` : null,
    `STEP: ${step.id}${step.note ? ` — ${step.note}` : ''}`,
    inputsSection,
    prevSection,
    'Carry out this step now.',
    decisionTrailer,
  ].filter((l) => l != null).join('\n')
}

/* ===== Default executor ===== */

/**
 * Test-friendly default. Emits the agent's name + step id + (when branches)
 * a deterministic decision picked from `decisions[stepId]` if provided, else
 * the first branch key. No timing — completes synchronously for fast tests.
 */
export class SimulatedAgentExecutor implements AgentStepExecutor {
  constructor(private decisions: Record<string, string> = {}) {}
  async execute(ctx: StepContext, hooks: ExecutorHooks) {
    if (hooks.shouldCancel()) return { status: 'cancelled' as const, output: '' }
    const intro = `[${ctx.agent.name}] running step ${ctx.step.id}`
    hooks.emitChunk(intro + '\n')
    if (hooks.shouldCancel()) return { status: 'cancelled' as const, output: intro + '\n' }
    let output = intro + '\n'
    if (ctx.needsDecision) {
      const branchKeys = Object.keys(ctx.step.branches!)
      const decision = this.decisions[ctx.step.id] ?? branchKeys[0]!
      const line = `DECISION: ${decision}`
      hooks.emitChunk(line + '\n')
      output += line + '\n'
    }
    return { status: 'completed' as const, output }
  }
}

/* ===== Runner ===== */

const MAX_STEPS = 64

export class WorkflowRunner {
  private cancelFlags = new Map<string, boolean>()
  private executor: AgentStepExecutor

  constructor(private deps: WorkflowRunnerDeps) {
    this.executor = deps.executor ?? new SimulatedAgentExecutor()
  }

  /** Replace the step executor (commit 3 wires this for the pi-bridge variant). */
  setExecutor(executor: AgentStepExecutor): void {
    this.executor = executor
  }

  /** Late-binding setter for the run-complete callback. Used by wiring.ts to
   *  attach the WorkflowReviewRunner after both objects are constructed
   *  (the review runner depends on this runner for `start()` calls). */
  setOnRunComplete(cb: WorkflowRunnerDeps['onRunComplete']): void {
    this.deps = { ...this.deps, onRunComplete: cb }
  }

  /** Spawn a new run. Returns the runId; execution proceeds async. */
  async start(args: RunnerStartArgs): Promise<string> {
    const { workflow, agents } = args
    if (!workflow.id) throw new RunnerError('BAD_WORKFLOW', 'workflow.id required')
    if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
      throw new RunnerError('NO_STEPS', `workflow ${workflow.id} has no steps`)
    }
    // Validate every step's agentId resolves in the provided roster.
    const agentMap = new Map(agents.map((a) => [a.id, a]))
    const stepIds = new Set(workflow.steps.map((s) => s.id))
    for (const s of workflow.steps) {
      if (!agentMap.has(s.agentId)) {
        throw new RunnerError('MISSING_AGENT', `agent ${s.agentId} not in provided roster`, { agentId: s.agentId })
      }
      // Validate next / branches point at known step ids or 'end'.
      if (s.next && s.next !== 'end' && !stepIds.has(s.next)) {
        throw new RunnerError('BAD_NEXT', `step ${s.id}.next references unknown step ${s.next}`)
      }
      if (s.branches) {
        for (const [k, v] of Object.entries(s.branches)) {
          if (v !== 'end' && !stepIds.has(v)) {
            throw new RunnerError('BAD_BRANCH', `step ${s.id}.branches.${k} references unknown step ${v}`)
          }
        }
      }
    }

    const active = this.deps.store.activeRun(workflow.id)
    if (active) {
      throw new RunnerError('ACTIVE_RUN', `workflow ${workflow.id} already running (run=${active.id})`, { activeRunId: active.id })
    }

    const runId = randomUUID()
    this.deps.store.createRun({
      id: runId,
      workflow: workflow.id,
      workflowName: workflow.name,
      triggeredBy: args.triggeredBy ?? null,
      steps: workflow.steps.map((s) => ({
        id: s.id, agentId: s.agentId, note: s.note,
        branches: s.branches, next: s.next,
      })),
    })
    const bus = this.deps.bus.getOrCreate(runId)

    void this.execute(runId, workflow, agentMap, bus, args.inputs)
      .catch((err) => {
        console.error(`[workflow-runner] run ${runId} crashed:`, err)
        const msg = (err as Error).message
        this.deps.store.setRunStatus(runId, 'failed', { error: msg })
        bus.emit({ kind: 'run.end', runId, status: 'failed', error: msg, ts: Date.now() })
        this.deps.bus.markClosed(runId)
      })
      .finally(() => {
        // Fire onRunComplete from a try/catch — never surface to user.
        // We re-read the final run row so the callback gets the canonical
        // status (completed | failed | cancelled), not whatever this thread
        // last touched.
        try {
          const cb = this.deps.onRunComplete
          if (!cb) return
          const finalRun = this.deps.store.getRun(runId)
          if (!finalRun) return
          const status = finalRun.status as 'completed' | 'failed' | 'cancelled' | 'queued' | 'running'
          if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return
          // Don't await — the callback runs in the background. Hive's review
          // workflow itself goes through this runner; awaiting would
          // sequentialise unrelated runs and block tests.
          Promise.resolve(cb({
            runId,
            workflowId: finalRun.workflow,
            workflowName: finalRun.workflow_name,
            status,
            triggeredBy: finalRun.triggered_by,
          })).catch((err) => {
            console.error(`[workflow-runner] onRunComplete threw for ${runId}:`, err)
          })
        } catch (err) {
          console.error(`[workflow-runner] onRunComplete dispatch failed for ${runId}:`, err)
        }
      })
    return runId
  }

  cancel(runId: string): void {
    this.cancelFlags.set(runId, true)
  }

  private async execute(
    runId: string,
    workflow: Workflow,
    agentMap: Map<string, AgentDef>,
    bus: WorkflowRunBus,
    inputs?: Record<string, string>,
  ): Promise<void> {
    this.deps.store.setRunStatus(runId, 'running')
    bus.emit({
      kind: 'run.start',
      runId, workflowId: workflow.id, name: workflow.name,
      stepCount: workflow.steps.length, ts: Date.now(),
    })

    const stepById = new Map(workflow.steps.map((s) => [s.id, s]))
    const indexById = new Map(workflow.steps.map((s, i) => [s.id, i]))
    let cursorId: string = workflow.steps[0]!.id
    let visited = 0
    let stepDone = 0
    let prevOutput = ''

    while (cursorId !== 'end') {
      if (visited >= MAX_STEPS) {
        this.deps.store.setRunStatus(runId, 'failed', { error: 'MAX_STEPS exceeded' })
        bus.emit({ kind: 'run.end', runId, status: 'failed', error: 'MAX_STEPS exceeded', ts: Date.now() })
        this.deps.bus.markClosed(runId)
        return
      }
      visited++

      if (this.cancelFlags.get(runId)) {
        this.deps.store.setRunStatus(runId, 'cancelled', { stepDone })
        bus.emit({ kind: 'run.end', runId, status: 'cancelled', ts: Date.now() })
        this.deps.bus.markClosed(runId)
        this.cancelFlags.delete(runId)
        return
      }

      const step = stepById.get(cursorId)
      const stepIndex = indexById.get(cursorId)!
      if (!step) {
        const err = `unknown step id: ${cursorId}`
        this.deps.store.setRunStatus(runId, 'failed', { error: err, stepDone })
        bus.emit({ kind: 'run.end', runId, status: 'failed', error: err, ts: Date.now() })
        this.deps.bus.markClosed(runId)
        return
      }
      const agent = agentMap.get(step.agentId)
      if (!agent) {
        const err = `agent ${step.agentId} not in roster`
        this.deps.store.startStep(runId, stepIndex)
        this.deps.store.finishStep(runId, stepIndex, { status: 'failed', error: err })
        bus.emit({
          kind: 'step.end', runId, stepIndex, stepId: step.id, agentId: step.agentId,
          status: 'failed', decision: null, next: null, output: null, error: err, ts: Date.now(),
        })
        this.deps.store.setRunStatus(runId, 'failed', { error: err, stepDone })
        bus.emit({ kind: 'run.end', runId, status: 'failed', error: err, ts: Date.now() })
        this.deps.bus.markClosed(runId)
        return
      }

      this.deps.store.startStep(runId, stepIndex)
      bus.emit({
        kind: 'step.start',
        runId, stepIndex, stepId: step.id, agentId: agent.id, ts: Date.now(),
      })

      const prompt = composePrompt(workflow, step, agent, prevOutput, inputs)
      const ctx: StepContext = {
        workflow, agent, step,
        workflowRunId: runId, stepIndex,
        prompt,
        needsDecision: !!step.branches && Object.keys(step.branches).length > 0,
      }
      const collected: string[] = []
      const result = await this.executor.execute(ctx, {
        emitChunk: (chunk) => {
          collected.push(chunk)
          this.deps.store.appendStepOutput(runId, stepIndex, chunk)
          bus.emit({
            kind: 'step.output',
            runId, stepIndex, stepId: step.id, chunk, ts: Date.now(),
          })
        },
        shouldCancel: () => this.cancelFlags.get(runId) === true,
      }).catch((err) => ({
        status: 'failed' as const,
        output: collected.join(''),
        error: (err as Error).message,
      }))

      // Persist piRunId if the executor surfaced one.
      if ('piRunId' in result && result.piRunId) {
        this.deps.store.startStep(runId, stepIndex, { piRunId: result.piRunId })
      }

      if (result.status === 'cancelled') {
        this.deps.store.finishStep(runId, stepIndex, {
          status: 'skipped', output: result.output, decision: null, next: null,
        })
        bus.emit({
          kind: 'step.end', runId, stepIndex, stepId: step.id, agentId: agent.id,
          status: 'skipped', decision: null, next: null, output: result.output, ts: Date.now(),
        })
        this.deps.store.setRunStatus(runId, 'cancelled', { stepDone })
        bus.emit({ kind: 'run.end', runId, status: 'cancelled', ts: Date.now() })
        this.deps.bus.markClosed(runId)
        this.cancelFlags.delete(runId)
        return
      }

      if (result.status === 'failed') {
        this.deps.store.finishStep(runId, stepIndex, {
          status: 'failed', output: result.output, error: result.error,
          decision: null, next: null,
        })
        bus.emit({
          kind: 'step.end', runId, stepIndex, stepId: step.id, agentId: agent.id,
          status: 'failed', decision: null, next: null, output: result.output,
          error: result.error, ts: Date.now(),
        })
        this.deps.store.setRunStatus(runId, 'failed', { error: result.error, stepDone })
        bus.emit({ kind: 'run.end', runId, status: 'failed', error: result.error, ts: Date.now() })
        this.deps.bus.markClosed(runId)
        return
      }

      // success
      const decision = ctx.needsDecision ? parseDecisionToken(result.output) : null
      const next = chooseNext(step, decision, workflow.steps, stepIndex)
      this.deps.store.finishStep(runId, stepIndex, {
        status: 'completed', output: result.output, decision, next,
      })
      bus.emit({
        kind: 'step.end', runId, stepIndex, stepId: step.id, agentId: agent.id,
        status: 'completed', decision, next, output: result.output, ts: Date.now(),
      })

      stepDone++
      this.deps.store.setRunStatus(runId, 'running', { stepDone })
      prevOutput = result.output
      cursorId = next
    }

    this.deps.store.setRunStatus(runId, 'completed', { stepDone })
    bus.emit({ kind: 'run.end', runId, status: 'completed', ts: Date.now() })
    this.deps.bus.markClosed(runId)
    this.cancelFlags.delete(runId)
  }
}

export class RunnerError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) {
    super(message)
  }
}
