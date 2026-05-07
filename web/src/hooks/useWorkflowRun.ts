/**
 * useWorkflowRun — owns one workflow's run state in the canvas.
 *
 * Provides:
 *   - per-step (stepId-keyed) status + output + decision + next
 *   - the current runId (or null if no run in flight or never run)
 *   - run() / cancel() actions
 *
 * On run(): POST /api/workflow-runs { workflow, agents, triggeredBy }
 * Subscribes to /api/workflow-runs/:runId/events when a run is active.
 * On run.end, drops the SSE source but keeps state for inspection.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  cancelWorkflowRun, listWorkflowRuns, startWorkflowRun, workflowRunEventsUrl,
  type WorkflowStepStatus, type WorkflowRunStatus,
} from '../lib/api'
import type { Workflow } from '../lib/workflows-store'
import type { Agent } from '../lib/agents-store'

export interface CardState {
  stepId: string
  status: WorkflowStepStatus | 'idle'
  output: string
  decision: string | null
  next: string | null
  error: string | null
}

export interface RunState {
  runId: string | null
  status: WorkflowRunStatus | 'idle'
  cards: Record<string, CardState>
  activeStepId: string | null
  error: string | null
}

const EMPTY: RunState = { runId: null, status: 'idle', cards: {}, activeStepId: null, error: null }

function blankCard(stepId: string): CardState {
  return { stepId, status: 'idle', output: '', decision: null, next: null, error: null }
}

function seedCards(workflow: Workflow): Record<string, CardState> {
  const out: Record<string, CardState> = {}
  for (const s of workflow.steps) out[s.id] = blankCard(s.id)
  return out
}

export function useWorkflowRun(workflow: Workflow | null, agents: Agent[]): {
  state: RunState
  run: () => Promise<void>
  cancel: () => Promise<void>
  starting: boolean
  startError: string | null
} {
  const [state, setState] = useState<RunState>(EMPTY)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const sourceRef = useRef<EventSource | null>(null)

  // Reset state when the workflow id changes; reload most recent run if any.
  const workflowId = workflow?.id ?? null
  useEffect(() => {
    sourceRef.current?.close()
    sourceRef.current = null
    if (!workflow) { setState(EMPTY); return }
    setState({ ...EMPTY, cards: seedCards(workflow) })
    let cancelled = false
    listWorkflowRuns(workflow.id).then((res) => {
      if (cancelled || res.runs.length === 0) return
      const latest = res.runs[0]!
      setState((s) => ({ ...s, runId: latest.id, status: latest.status, error: latest.error }))
      if (latest.status === 'running' || latest.status === 'queued') attach(latest.id)
    }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId])

  const upsert = useCallback((stepId: string, patch: Partial<CardState>) => {
    setState((s) => {
      const cur = s.cards[stepId] ?? blankCard(stepId)
      return { ...s, cards: { ...s.cards, [stepId]: { ...cur, ...patch } } }
    })
  }, [])

  const attach = useCallback((runId: string) => {
    sourceRef.current?.close()
    const src = new EventSource(workflowRunEventsUrl(runId), { withCredentials: true })
    sourceRef.current = src

    src.addEventListener('run.start', (ev: MessageEvent) => {
      // Reset all cards to 'queued' at run.start so a re-run starts fresh.
      setState((s) => {
        const cards: Record<string, CardState> = {}
        for (const id of Object.keys(s.cards)) {
          cards[id] = { ...blankCard(id), status: 'queued' }
        }
        return { ...s, status: 'running', cards, activeStepId: null, error: null }
      })
      void ev
    })

    src.addEventListener('step.start', (ev: MessageEvent) => {
      const evt = JSON.parse(ev.data) as { stepId: string; agentId: string }
      upsert(evt.stepId, { status: 'running' })
      setState((s) => ({ ...s, activeStepId: evt.stepId }))
    })

    src.addEventListener('step.output', (ev: MessageEvent) => {
      const evt = JSON.parse(ev.data) as { stepId: string; chunk: string }
      setState((s) => {
        const cur = s.cards[evt.stepId] ?? blankCard(evt.stepId)
        return { ...s, cards: { ...s.cards, [evt.stepId]: { ...cur, output: cur.output + evt.chunk } } }
      })
    })

    src.addEventListener('step.end', (ev: MessageEvent) => {
      const evt = JSON.parse(ev.data) as {
        stepId: string
        status: WorkflowStepStatus
        decision: string | null
        next: string | null
        output: string | null
        error?: string
      }
      upsert(evt.stepId, {
        status: evt.status,
        decision: evt.decision,
        next: evt.next,
        error: evt.error ?? null,
        // step.end carries the canonical output; prefer it over our streamed
        // approximation so we don't show partial output if step.output events
        // got coalesced.
        ...(evt.output != null ? { output: evt.output } : {}),
      })
    })

    src.addEventListener('run.end', (ev: MessageEvent) => {
      const evt = JSON.parse(ev.data) as { status: WorkflowRunStatus; error?: string }
      setState((s) => ({ ...s, status: evt.status, activeStepId: null, error: evt.error ?? null }))
      src.close(); sourceRef.current = null
    })

    src.onerror = () => { /* browser will retry */ }
  }, [upsert])

  const run = useCallback(async () => {
    if (!workflow) return
    setStarting(true); setStartError(null)
    try {
      const usedIds = new Set(workflow.steps.map((s) => s.agentId))
      const usedAgents = agents.filter((a) => usedIds.has(a.id))
      const res = await startWorkflowRun(workflow, usedAgents)
      setState((s) => ({ ...s, runId: res.runId, status: 'queued', error: null }))
      attach(res.runId)
    } catch (err) {
      setStartError((err as Error).message)
    } finally { setStarting(false) }
  }, [workflow, agents, attach])

  const cancel = useCallback(async () => {
    if (!state.runId) return
    try { await cancelWorkflowRun(state.runId) } catch { /* ignore */ }
  }, [state.runId])

  useEffect(() => () => { sourceRef.current?.close() }, [])

  return { state, run, cancel, starting, startError }
}
