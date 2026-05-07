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
 *
 * v2 (2026-05-07): each card now carries a structured `logs: LogEntry[]`
 * trail driven by the SSE stream. Backend events already attach `ts`
 * (Date.now()) — we forward it; falling back to client time if absent.
 * The drawer + side-panel preview both read this list. The raw
 * `cardState.output` concat is preserved for back-compat consumers.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  cancelWorkflowRun, listWorkflowRuns, startWorkflowRun, workflowRunEventsUrl,
  type WorkflowStepStatus, type WorkflowRunStatus,
} from '../lib/api'
import type { Workflow } from '../lib/workflows-store'
import type { Agent } from '../lib/agents-store'

export type LogTag = 'run' | 'step' | 'out' | 'tool' | 'err' | 'end'
export interface LogEntry { ts: number; tag: LogTag; text: string }

/** Synthetic step id for workflow-level events (rendered as the "Run" tab). */
export const RUN_STEP_ID = '__run__'

/** Ring-buffer caps. When exceeded we trim from the head and prepend a single
 *  `[trimmed N lines]` notice so the user knows old entries were dropped. */
const MAX_LOG_ENTRIES = 5000
const MAX_OUTPUT_BYTES = 256 * 1024 // 256 KB

export interface CardState {
  stepId: string
  status: WorkflowStepStatus | 'idle'
  output: string
  decision: string | null
  next: string | null
  error: string | null
  /** Structured per-line log feed for the drawer / side-panel preview. */
  logs: LogEntry[]
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
  return { stepId, status: 'idle', output: '', decision: null, next: null, error: null, logs: [] }
}

function seedCards(workflow: Workflow): Record<string, CardState> {
  const out: Record<string, CardState> = {}
  for (const s of workflow.steps) out[s.id] = blankCard(s.id)
  // Synthetic run-level bucket is always present so the "Run" tab can render
  // even before any per-step events fire.
  out[RUN_STEP_ID] = blankCard(RUN_STEP_ID)
  return out
}

/** Append entries to a log array with trim-from-head + a [trimmed N] notice
 *  when we cross the cap. Returns a new array (never mutates). */
function appendLogs(existing: LogEntry[], adds: LogEntry[]): LogEntry[] {
  if (adds.length === 0) return existing
  const next = existing.concat(adds)
  if (next.length <= MAX_LOG_ENTRIES) return next
  const overflow = next.length - MAX_LOG_ENTRIES
  // Drop overflow oldest, but if the oldest is itself a trimmed-notice, fold
  // the count into it instead of stacking notices.
  const headIsNotice = next[overflow]?.tag === 'run' && /^\[trimmed \d+ lines\]/.test(next[overflow]!.text)
  const tail = next.slice(overflow + (headIsNotice ? 1 : 0))
  const carryover = headIsNotice
    ? Number(/^\[trimmed (\d+) lines\]/.exec(next[overflow]!.text)?.[1] ?? '0')
    : 0
  const notice: LogEntry = {
    ts: Date.now(),
    tag: 'run',
    text: `[trimmed ${carryover + overflow} lines]`,
  }
  return [notice, ...tail]
}

/** Cap raw output text at MAX_OUTPUT_BYTES; trim head + prepend a notice. */
function capOutput(s: string): string {
  if (s.length <= MAX_OUTPUT_BYTES) return s
  const dropped = s.length - MAX_OUTPUT_BYTES
  const tail = s.slice(dropped)
  return `[trimmed ${dropped} bytes]\n${tail}`
}

export function useWorkflowRun(workflow: Workflow | null, agents: Agent[]): {
  state: RunState
  run: (inputs?: Record<string, string>) => Promise<void>
  cancel: () => Promise<void>
  starting: boolean
  startError: string | null
} {
  const [state, setState] = useState<RunState>(EMPTY)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const sourceRef = useRef<EventSource | null>(null)
  /** Per-step partial-line buffer for the chunk → line splitter. We hold the
   *  trailing partial (no \n yet) until either more bytes arrive or the step
   *  ends, at which point we flush whatever's there as a final [out] line. */
  const partialBufRef = useRef<Map<string, string>>(new Map())

  // Reset state when the workflow id changes; reload most recent run if any.
  const workflowId = workflow?.id ?? null
  useEffect(() => {
    sourceRef.current?.close()
    sourceRef.current = null
    partialBufRef.current.clear()
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

  /** Append entries to a card's `logs`. If the card doesn't exist yet (e.g.
   *  events arrive before workflow seed completes), create a blank card. */
  const pushLogs = useCallback((stepId: string, entries: LogEntry[]) => {
    setState((s) => {
      const cur = s.cards[stepId] ?? blankCard(stepId)
      return {
        ...s,
        cards: {
          ...s.cards,
          [stepId]: { ...cur, logs: appendLogs(cur.logs, entries) },
        },
      }
    })
  }, [])

  const attach = useCallback((runId: string) => {
    sourceRef.current?.close()
    const src = new EventSource(workflowRunEventsUrl(runId), { withCredentials: true })
    sourceRef.current = src

    src.addEventListener('run.start', (ev: MessageEvent) => {
      const evt = parseEvent(ev) as { ts?: number }
      const ts = evt.ts ?? Date.now()
      partialBufRef.current.clear()
      // Reset all cards to 'queued' at run.start so a re-run starts fresh,
      // and seed the synthetic Run bucket with a "started" entry.
      setState((s) => {
        const cards: Record<string, CardState> = {}
        for (const id of Object.keys(s.cards)) {
          cards[id] = { ...blankCard(id), status: id === RUN_STEP_ID ? 'idle' : 'queued' }
        }
        // Carry-forward / create the synthetic run bucket and add the entry.
        const runBucket = cards[RUN_STEP_ID] ?? blankCard(RUN_STEP_ID)
        cards[RUN_STEP_ID] = {
          ...runBucket,
          logs: appendLogs(runBucket.logs, [{ ts, tag: 'run', text: 'workflow started' }]),
        }
        return { ...s, status: 'running', cards, activeStepId: null, error: null }
      })
    })

    src.addEventListener('step.start', (ev: MessageEvent) => {
      const evt = parseEvent(ev) as { stepId: string; agentId: string; ts?: number }
      const ts = evt.ts ?? Date.now()
      upsert(evt.stepId, { status: 'running' })
      pushLogs(evt.stepId, [{ ts, tag: 'step', text: `starting${evt.agentId ? ` (${evt.agentId})` : ''}…` }])
      setState((s) => ({ ...s, activeStepId: evt.stepId }))
    })

    src.addEventListener('step.output', (ev: MessageEvent) => {
      const evt = parseEvent(ev) as { stepId: string; chunk: string; ts?: number }
      const ts = evt.ts ?? Date.now()
      // 1. Maintain the canonical raw concatenation (capped) for back-compat.
      setState((s) => {
        const cur = s.cards[evt.stepId] ?? blankCard(evt.stepId)
        return { ...s, cards: { ...s.cards, [evt.stepId]: { ...cur, output: capOutput(cur.output + evt.chunk) } } }
      })
      // 2. Split the chunk into lines, prepending the held partial. Whatever
      //    has no trailing \n stays in the buffer until next chunk or step.end.
      const buf = partialBufRef.current
      const combined = (buf.get(evt.stepId) ?? '') + evt.chunk
      const parts = combined.split('\n')
      const partial = parts.pop() ?? ''
      buf.set(evt.stepId, partial)
      const newLines = parts
        .filter((l) => l.length > 0)
        .map((l): LogEntry => ({ ts, tag: 'out', text: l }))
      if (newLines.length > 0) pushLogs(evt.stepId, newLines)
    })

    src.addEventListener('step.end', (ev: MessageEvent) => {
      const evt = parseEvent(ev) as {
        stepId: string
        status: WorkflowStepStatus
        decision: string | null
        next: string | null
        output: string | null
        error?: string
        ts?: number
      }
      const ts = evt.ts ?? Date.now()
      // Flush any held partial as a final [out] line so nothing's lost.
      const buf = partialBufRef.current
      const partial = buf.get(evt.stepId)
      const flushEntries: LogEntry[] = []
      if (partial && partial.length > 0) flushEntries.push({ ts, tag: 'out', text: partial })
      buf.delete(evt.stepId)
      // Lifecycle line.
      const summary = `status=${evt.status}` +
        (evt.decision ? ` decision=${evt.decision}` : '') +
        (evt.next ? ` next=${evt.next}` : '')
      flushEntries.push({ ts, tag: 'end', text: summary })
      if (evt.error) flushEntries.push({ ts, tag: 'err', text: evt.error })
      pushLogs(evt.stepId, flushEntries)

      upsert(evt.stepId, {
        status: evt.status,
        decision: evt.decision,
        next: evt.next,
        error: evt.error ?? null,
        // step.end carries the canonical output; prefer it over our streamed
        // approximation so we don't show partial output if step.output events
        // got coalesced.
        ...(evt.output != null ? { output: capOutput(evt.output) } : {}),
      })
    })

    src.addEventListener('run.end', (ev: MessageEvent) => {
      const evt = parseEvent(ev) as { status: WorkflowRunStatus; error?: string; ts?: number }
      const ts = evt.ts ?? Date.now()
      pushLogs(RUN_STEP_ID, [{ ts, tag: 'run', text: `workflow ${evt.status}${evt.error ? `: ${evt.error}` : ''}` }])
      setState((s) => ({ ...s, status: evt.status, activeStepId: null, error: evt.error ?? null }))
      src.close(); sourceRef.current = null
    })

    src.onerror = () => { /* browser will retry */ }
  }, [upsert, pushLogs])

  const run = useCallback(async (inputs?: Record<string, string>) => {
    if (!workflow) return
    setStarting(true); setStartError(null)
    try {
      const usedIds = new Set(workflow.steps.map((s) => s.agentId))
      const usedAgents = agents.filter((a) => usedIds.has(a.id))
      const res = await startWorkflowRun(workflow, usedAgents, 'operator', inputs)
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

function parseEvent(ev: MessageEvent): Record<string, unknown> {
  try { return JSON.parse(ev.data) } catch { return {} }
}
