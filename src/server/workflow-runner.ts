/**
 * WorkflowRunner — sequential v1 executor.
 *
 * Walks `steps[]`. For each step:
 *   1. Mark step running, emit `step.start`.
 *   2. Resolve the step (load skill body or recurse for sub-workflow).
 *   3. Drive the configured `StepExecutor` to "run" the step.
 *      Default executor is `SimulatedStepExecutor` — produces realistic
 *      lifecycle events without touching pi. The real pi-bridge executor
 *      arrives in a later spec; until then chat and workflows stay decoupled.
 *   4. Mark step completed/failed, persist output, emit `step.end`.
 *
 * Failure halts the run. Cancellation is cooperative — the runner checks the
 * cancel flag between steps and emits `run.end status=cancelled`.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs/promises'

import type { WorkflowRunsStore } from './workflow-runs-store.js'
import type { WorkflowRunBusRegistry } from './workflow-run-bus.js'
import { decodeSteps } from './workflow-writer.js'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

/** Tiny YAML scalar parser — handles `key: value` and `key:` followed by `- item` lists. */
function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return { frontmatter: {}, body: raw }
  const fm: Record<string, unknown> = {}
  let lastList: string | null = null
  for (const lineRaw of (m[1] ?? '').split(/\r?\n/)) {
    const line = lineRaw.trimEnd()
    if (!line.trim()) { lastList = null; continue }
    const listItem = /^\s*-\s*(.*)$/.exec(line)
    if (listItem && lastList) {
      const arr = (fm[lastList] as string[] | undefined) ?? []
      arr.push(unquote(listItem[1] ?? ''))
      fm[lastList] = arr
      continue
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]!
    const val = kv[2] ?? ''
    if (val === '') { fm[key] = []; lastList = key; continue }
    fm[key] = unquote(val); lastList = null
  }
  return { frontmatter: fm, body: (m[2] ?? '') }
}

function unquote(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

export interface WorkflowStep {
  kind: 'skill' | 'workflow'
  ref: string
}

export interface StepContext {
  workflow: string
  runId: string
  stepIndex: number
  step: WorkflowStep
  /** Resolved skill or sub-workflow body (markdown, frontmatter stripped). */
  body: string
  description: string | null
}

export interface StepExecutor {
  execute(ctx: StepContext, hooks: ExecutorHooks): Promise<{ status: 'completed' | 'failed'; output?: string; error?: string }>
}

export interface ExecutorHooks {
  emitChunk(chunk: string): void
  shouldCancel(): boolean
}

/**
 * Default executor for v1 — simulates execution by emitting the skill's title
 * + a few canned progress lines. Honest about what it is: a visualizer driver,
 * not a real agent run. Produces output that's readable in the rail.
 */
export class SimulatedStepExecutor implements StepExecutor {
  async execute(ctx: StepContext, hooks: ExecutorHooks) {
    const lines = [
      `▸ ${ctx.step.kind}:${ctx.step.ref}`,
      ctx.description ? `  ${ctx.description}` : '',
      '',
      previewBody(ctx.body),
      '',
      `✓ ${ctx.step.kind}:${ctx.step.ref} done`,
    ].filter(Boolean)
    for (const line of lines) {
      if (hooks.shouldCancel()) return { status: 'failed' as const, error: 'cancelled' }
      hooks.emitChunk(line + '\n')
      await sleep(180 + Math.random() * 220)
    }
    return { status: 'completed' as const, output: lines.join('\n') }
  }
}

function previewBody(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return '(no body)'
  return trimmed.split('\n').slice(0, 6).join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface WorkflowRunnerDeps {
  store: WorkflowRunsStore
  bus: WorkflowRunBusRegistry
  kbRoot: string
  executor?: StepExecutor
}

export class WorkflowRunner {
  private cancelFlags = new Map<string, boolean>()
  private executor: StepExecutor

  constructor(private deps: WorkflowRunnerDeps) {
    this.executor = deps.executor ?? new SimulatedStepExecutor()
  }

  /** Loads a workflow's frontmatter and decodes its steps. */
  async loadSteps(workflow: string): Promise<WorkflowStep[]> {
    const file = path.join(this.deps.kbRoot, 'workflows', workflow, 'WORKFLOW.md')
    const raw = await fs.readFile(file, 'utf8')
    const { frontmatter } = parseFrontmatter(raw)
    return decodeSteps((frontmatter as { steps?: unknown }).steps)
  }

  /** Loads body + description for a single step (skill or sub-workflow). */
  private async loadStepResource(step: WorkflowStep): Promise<{ body: string; description: string | null }> {
    const subdir = step.kind === 'skill' ? 'skills' : 'workflows'
    const filename = step.kind === 'skill' ? 'SKILL.md' : 'WORKFLOW.md'
    const file = path.join(this.deps.kbRoot, subdir, step.ref, filename)
    try {
      const raw = await fs.readFile(file, 'utf8')
      const { frontmatter, body } = parseFrontmatter(raw)
      const desc = (frontmatter as { description?: unknown }).description
      return { body, description: typeof desc === 'string' ? desc : null }
    } catch {
      return { body: `(missing: ${step.kind}:${step.ref})`, description: null }
    }
  }

  /** Spawn a new run. Returns the runId immediately; execution proceeds async. */
  async start(workflow: string, opts: { triggeredBy?: string } = {}): Promise<string> {
    const steps = await this.loadSteps(workflow)
    if (steps.length === 0) throw new RunnerError('NO_STEPS', `workflow ${workflow} has no steps`)
    const active = this.deps.store.activeRun(workflow)
    if (active) throw new RunnerError('ACTIVE_RUN', `workflow ${workflow} already running (run=${active.id})`, { activeRunId: active.id })

    const runId = randomUUID()
    // Legacy v1 path: synthesize minimal AgentStepInput shape so the v2 store
    // accepts our skill/workflow refs. Commit 2 replaces this runner with the
    // agent-driven version; this is just a transient adapter to keep tsc green.
    this.deps.store.createRun({
      id: runId, workflow, workflowName: workflow,
      triggeredBy: opts.triggeredBy ?? null,
      steps: steps.map((s, i) => ({ id: `step-${i + 1}`, agentId: `${s.kind}:${s.ref}` })),
    })
    const bus = this.deps.bus.getOrCreate(runId)

    // Kick off execution; never await — the route returns immediately.
    void this.execute(runId, workflow, steps, bus).catch((err) => {
      console.error(`[workflow-runner] run ${runId} crashed:`, err)
      this.deps.store.setRunStatus(runId, 'failed', { error: (err as Error).message })
      bus.emit({ kind: 'run.end', runId, status: 'failed', error: (err as Error).message, ts: Date.now() })
      this.deps.bus.markClosed(runId)
    })
    return runId
  }

  cancel(runId: string): void {
    this.cancelFlags.set(runId, true)
  }

  private async execute(runId: string, workflow: string, steps: WorkflowStep[], bus: ReturnType<WorkflowRunBusRegistry['getOrCreate']>): Promise<void> {
    this.deps.store.setRunStatus(runId, 'running')
    bus.emit({ kind: 'run.start', runId, workflow, stepCount: steps.length, ts: Date.now() })

    let stepDone = 0
    for (let i = 0; i < steps.length; i++) {
      if (this.cancelFlags.get(runId)) {
        this.deps.store.setRunStatus(runId, 'cancelled', { stepDone })
        bus.emit({ kind: 'run.end', runId, status: 'cancelled', ts: Date.now() })
        this.deps.bus.markClosed(runId)
        return
      }
      const step = steps[i]!
      this.deps.store.startStep(runId, i)
      bus.emit({ kind: 'step.start', runId, stepIndex: i, ts: Date.now() })
      const resource = await this.loadStepResource(step)
      const ctx: StepContext = { workflow, runId, stepIndex: i, step, body: resource.body, description: resource.description }

      const result = await this.executor.execute(ctx, {
        emitChunk: (chunk) => {
          this.deps.store.appendStepOutput(runId, i, chunk)
          bus.emit({ kind: 'step.output', runId, stepIndex: i, chunk, ts: Date.now() })
        },
        shouldCancel: () => this.cancelFlags.get(runId) === true,
      }).catch((err) => ({ status: 'failed' as const, error: (err as Error).message }))

      if (result.status === 'failed') {
        // If cancellation was requested mid-step, finalize as cancelled, not failed.
        const cancelled = this.cancelFlags.get(runId) === true
        const stepStatus = cancelled ? 'skipped' : 'failed'
        this.deps.store.finishStep(runId, i, { status: stepStatus, error: result.error })
        bus.emit({ kind: 'step.end', runId, stepIndex: i, status: stepStatus, error: result.error, ts: Date.now() })
        const runStatus = cancelled ? 'cancelled' : 'failed'
        this.deps.store.setRunStatus(runId, runStatus, { error: cancelled ? null : result.error, stepDone })
        bus.emit({ kind: 'run.end', runId, status: runStatus, error: cancelled ? undefined : result.error, ts: Date.now() })
        this.deps.bus.markClosed(runId)
        this.cancelFlags.delete(runId)
        return
      }
      this.deps.store.finishStep(runId, i, { status: 'completed', output: result.output })
      bus.emit({ kind: 'step.end', runId, stepIndex: i, status: 'completed', ts: Date.now() })
      stepDone++
      this.deps.store.setRunStatus(runId, 'running', { stepDone })
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
