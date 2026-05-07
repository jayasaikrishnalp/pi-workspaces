/**
 * Per-workflow-run SSE bus. One bus per run; subscribers (the SSE route + UI)
 * receive lifecycle + per-step events. Idiomatic small bus mirroring KbEventBus.
 *
 * v2 (commit 2): events carry the agent-driven workflow shape — stepId,
 * agentId, decision, next on step.start/step.end; workflowId/name on
 * run.start. The legacy `workflow` and `stepIndex` fields are kept on
 * step events so existing readers don't break.
 */

export type WorkflowRunEvent =
  | {
      kind: 'run.start'
      runId: string
      workflowId: string
      name: string
      stepCount: number
      ts: number
    }
  | {
      kind: 'step.start'
      runId: string
      stepIndex: number
      stepId: string
      agentId: string
      ts: number
    }
  | {
      kind: 'step.output'
      runId: string
      stepIndex: number
      stepId: string
      chunk: string
      ts: number
    }
  | {
      kind: 'step.end'
      runId: string
      stepIndex: number
      stepId: string
      agentId: string
      status: 'completed' | 'failed' | 'skipped'
      decision: string | null
      next: string | null
      output: string | null
      error?: string
      ts: number
    }
  | {
      kind: 'run.end'
      runId: string
      status: 'completed' | 'failed' | 'cancelled'
      error?: string
      ts: number
    }

type Handler = (e: WorkflowRunEvent) => void

export class WorkflowRunBus {
  private handlers = new Set<Handler>()
  private buffer: WorkflowRunEvent[] = []
  private maxBuffer = 1000

  subscribe(handler: Handler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  /** Returns recent events so a late subscriber can replay missed history. */
  history(): WorkflowRunEvent[] {
    return [...this.buffer]
  }

  emit(e: WorkflowRunEvent): void {
    this.buffer.push(e)
    if (this.buffer.length > this.maxBuffer) this.buffer.splice(0, this.buffer.length - this.maxBuffer)
    for (const h of Array.from(this.handlers)) {
      try { h(e) } catch (err) { console.error('[workflow-run-bus] handler threw:', err) }
    }
  }
}

/**
 * Registry of buses keyed by runId. Buses are created when a run starts and
 * closed when the run finishes (entry stays for ~5min so late subscribers can
 * still replay history before the entry is reaped).
 */
export class WorkflowRunBusRegistry {
  private buses = new Map<string, { bus: WorkflowRunBus; closedAt: number | null }>()
  private reapAfterMs = 5 * 60 * 1000

  getOrCreate(runId: string): WorkflowRunBus {
    let entry = this.buses.get(runId)
    if (!entry) {
      entry = { bus: new WorkflowRunBus(), closedAt: null }
      this.buses.set(runId, entry)
    }
    return entry.bus
  }

  get(runId: string): WorkflowRunBus | null {
    return this.buses.get(runId)?.bus ?? null
  }

  markClosed(runId: string): void {
    const entry = this.buses.get(runId)
    if (entry) entry.closedAt = Date.now()
    this.reap()
  }

  private reap(): void {
    const now = Date.now()
    for (const [id, entry] of this.buses) {
      if (entry.closedAt && now - entry.closedAt > this.reapAfterMs) {
        this.buses.delete(id)
      }
    }
  }
}
