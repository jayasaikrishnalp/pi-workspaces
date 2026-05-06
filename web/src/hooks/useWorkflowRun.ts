/**
 * useWorkflowRun — owns one workflow's run state in the conductor.
 *
 * Provides:
 *   - per-step status map (live, driven by SSE events)
 *   - per-step output buffer (live)
 *   - the current runId (or null if no run in flight or never run)
 *   - run() / cancel() actions
 *
 * Subscribes to /api/workflows/:name/run/:runId/events when a run is active.
 * On run.end, drops the SSE source but keeps state for inspection.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  cancelWorkflowRun, listWorkflowRuns, startWorkflowRun, workflowRunEventsUrl,
  type WorkflowStepStatus, type WorkflowRunStatus,
} from '../lib/api'

interface StepState {
  status: WorkflowStepStatus
  output: string
  error: string | null
}

interface RunState {
  runId: string | null
  status: WorkflowRunStatus | 'idle'
  steps: Record<number, StepState>
  error: string | null
}

const EMPTY: RunState = { runId: null, status: 'idle', steps: {}, error: null }

export function useWorkflowRun(workflow: string | null): {
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

  // Reset state when workflow changes; reload most recent run if any.
  useEffect(() => {
    sourceRef.current?.close()
    sourceRef.current = null
    setState(EMPTY)
    if (!workflow) return
    let cancelled = false
    listWorkflowRuns(workflow).then((res) => {
      if (cancelled || res.runs.length === 0) return
      const latest = res.runs[0]!
      setState({ runId: latest.id, status: latest.status, steps: {}, error: latest.error })
      // If still running, attach SSE.
      if (latest.status === 'running' || latest.status === 'queued') attach(workflow, latest.id)
    }).catch(() => { /* ignore */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow])

  const attach = useCallback((name: string, runId: string) => {
    sourceRef.current?.close()
    const src = new EventSource(workflowRunEventsUrl(name, runId), { withCredentials: true })
    sourceRef.current = src
    const upsert = (i: number, patch: Partial<StepState>) =>
      setState((s) => {
        const cur = s.steps[i] ?? { status: 'queued' as WorkflowStepStatus, output: '', error: null }
        return { ...s, steps: { ...s.steps, [i]: { ...cur, ...patch } } }
      })

    src.addEventListener('run.start', (ev: MessageEvent) => {
      const evt = JSON.parse(ev.data) as { stepCount: number }
      setState((s) => ({ ...s, status: 'running', steps: Object.fromEntries(Array.from({ length: evt.stepCount }, (_, i) => [i, { status: 'queued' as const, output: '', error: null }])) }))
    })
    src.addEventListener('step.start', (ev: MessageEvent) => {
      const evt = JSON.parse(ev.data) as { stepIndex: number }
      upsert(evt.stepIndex, { status: 'running' })
    })
    src.addEventListener('step.output', (ev: MessageEvent) => {
      const evt = JSON.parse(ev.data) as { stepIndex: number; chunk: string }
      setState((s) => {
        const cur = s.steps[evt.stepIndex] ?? { status: 'queued' as const, output: '', error: null }
        return { ...s, steps: { ...s.steps, [evt.stepIndex]: { ...cur, output: cur.output + evt.chunk } } }
      })
    })
    src.addEventListener('step.end', (ev: MessageEvent) => {
      const evt = JSON.parse(ev.data) as { stepIndex: number; status: WorkflowStepStatus; error?: string }
      upsert(evt.stepIndex, { status: evt.status, error: evt.error ?? null })
    })
    src.addEventListener('run.end', (ev: MessageEvent) => {
      const evt = JSON.parse(ev.data) as { status: WorkflowRunStatus; error?: string }
      setState((s) => ({ ...s, status: evt.status, error: evt.error ?? null }))
      src.close(); sourceRef.current = null
    })
    src.onerror = () => { /* browser will retry; nothing to do */ }
  }, [])

  const run = useCallback(async () => {
    if (!workflow) return
    setStarting(true); setStartError(null)
    try {
      const res = await startWorkflowRun(workflow)
      setState({ runId: res.runId, status: 'queued', steps: {}, error: null })
      attach(workflow, res.runId)
    } catch (err) {
      setStartError((err as Error).message)
    } finally { setStarting(false) }
  }, [workflow, attach])

  const cancel = useCallback(async () => {
    if (!workflow || !state.runId) return
    try { await cancelWorkflowRun(workflow, state.runId) } catch { /* ignore */ }
  }, [workflow, state.runId])

  useEffect(() => () => { sourceRef.current?.close() }, [])

  return { state, run, cancel, starting, startError }
}
