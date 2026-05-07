/**
 * WorkflowCanvas — Railway-style grid of agent cards connected by faint
 * dotted SVG curves. Live status driven by useWorkflowRun's SSE-fed state.
 *
 * Layout strategy (no graph layout library):
 *   1. canvas-layout.ts assigns each step to (column, lane).
 *   2. We render cards in a CSS grid (auto-flow column, fixed-width columns).
 *      Synthetic START and END nodes occupy column 0 and lastCol+2; every
 *      step cell is shifted +1 column to make room for START.
 *   3. After mount, an absolutely-positioned SVG overlay measures every
 *      card's bounding rect (relative to the INNER wrapper, not the
 *      scroll-port) and draws cubic Bézier paths between source
 *      right-center and target left-center.
 *   4. ResizeObserver re-measures on container resize.
 *
 * Card visual states are driven by CardState.status from the run hook;
 * edges highlight based on the run's progress (active → chosen → ghost).
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import '../../../styles/workflow-canvas.css'
import { Icons } from '../../icons/Icons'
import { layoutWorkflow, type Layout, type LaidOutStep } from './canvas-layout'
import type { Workflow, WorkflowStep } from '../../../lib/workflows-store'
import { AGENT_KIND_META, type Agent } from '../../../lib/agents-store'
import type { CardState, RunState } from '../../../hooks/useWorkflowRun'

interface Props {
  workflow: Workflow
  agents: Agent[]
  runState: RunState
  onCancel?: () => void
}

interface AnchorRect {
  left: number
  top: number
  width: number
  height: number
}

const START_ID = '__start__'
const END_ID = '__end__'
const COLUMN_OFFSET = 1 // push every step right by 1 to make room for START at col 0

function iconFor(name: string) {
  const all = Icons as unknown as Record<string, (p: { size?: number }) => JSX.Element>
  return all[name] ?? all.swarm
}

function tail(text: string, n = 80): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= n) return compact
  return '…' + compact.slice(-n + 1)
}

/** Identify steps that terminate the flow — i.e. their successor set
 *  contains 'end' OR they have no successors at all. */
function terminalSteps(workflow: Workflow): string[] {
  const out: string[] = []
  for (let i = 0; i < workflow.steps.length; i++) {
    const s = workflow.steps[i]!
    let goesToEnd = false
    let hasOutgoing = false
    if (s.branches) {
      for (const v of Object.values(s.branches)) {
        hasOutgoing = true
        if (v === 'end') goesToEnd = true
      }
    }
    if (s.next) {
      hasOutgoing = true
      if (s.next === 'end') goesToEnd = true
    } else if (!s.branches) {
      // Default-next is the next list element; if absent, we hit 'end'.
      const dflt = workflow.steps[i + 1]?.id
      if (dflt) hasOutgoing = true
      else goesToEnd = true
    }
    if (goesToEnd || !hasOutgoing) out.push(s.id)
  }
  return out
}

export function WorkflowCanvas({ workflow, agents, runState, onCancel }: Props): JSX.Element {
  void onCancel
  const layout: Layout = useMemo(() => layoutWorkflow(workflow), [workflow])
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  const containerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [rects, setRects] = useState<Record<string, AnchorRect>>({})
  const [innerSize, setInnerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [openStepId, setOpenStepId] = useState<string | null>(null)

  const totalColumns = layout.columnCount + 2 // +1 START, +1 END

  // Re-measure on layout / size change. We measure rects relative to the
  // INNER wrapper (which sizes to the natural grid content) so the SVG
  // overlay can use the same coordinate system without scroll-port clipping.
  useLayoutEffect(() => {
    const measure = () => {
      const inner = innerRef.current
      if (!inner) return
      const innerRect = inner.getBoundingClientRect()
      const next: Record<string, AnchorRect> = {}
      for (const [id, el] of Object.entries(cardRefs.current)) {
        if (!el) continue
        const r = el.getBoundingClientRect()
        next[id] = {
          left: r.left - innerRect.left,
          top: r.top - innerRect.top,
          width: r.width,
          height: r.height,
        }
      }
      setRects(next)
      setInnerSize({ w: inner.scrollWidth, h: inner.scrollHeight })
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (innerRef.current) ro.observe(innerRef.current)
    if (containerRef.current) ro.observe(containerRef.current)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [layout, totalColumns])

  // Synthetic edges: START → entry step, terminals → END. Real flow edges
  // come from layout.edges.
  const terminals = useMemo(() => terminalSteps(workflow), [workflow])
  const entryId = workflow.steps[0]?.id ?? null

  // Edge classification for the run state.
  const edgeClass = (fromId: string, toId: string, branchKey: string | undefined, isBackEdge: boolean): string => {
    void toId
    const cls: string[] = []
    if (isBackEdge) cls.push('back')
    if (fromId === START_ID) {
      // START → entry: chosen once the run kicks off.
      if (runState.status === 'running' || runState.status === 'completed') cls.push('chosen')
      return cls.join(' ')
    }
    if (toId === END_ID) {
      // Step → END: chosen once the run has completed AND that source ended.
      const fromCard = runState.cards[fromId]
      if (fromCard?.status === 'completed' && (fromCard.next === 'end' || fromCard.next == null)) cls.push('chosen')
      return cls.join(' ')
    }
    const fromCard = runState.cards[fromId]
    if (fromCard) {
      if (branchKey) {
        if (fromCard.decision != null) {
          if (fromCard.decision === branchKey) cls.push('chosen')
          else cls.push('ghost')
        }
      } else {
        if (fromCard.status === 'completed' && fromCard.next === toId) cls.push('chosen')
      }
      if (fromCard.status === 'running') cls.push('active')
    }
    return cls.join(' ')
  }

  const cycleBanner = layout.cycles.length > 0
    ? `Workflow contains a cycle (${layout.cycles.join(', ')}). Edges highlighted in amber.`
    : null

  return (
    <div className="wf-canvas" ref={containerRef} data-testid="wf-canvas">
      {cycleBanner ? <div className="wf-canvas-banner">⚠ {cycleBanner}</div> : null}
      {runState.error ? <div className="wf-canvas-banner err">⚠ {runState.error}</div> : null}

      <div className="wf-canvas-inner" ref={innerRef} data-testid="wf-canvas-inner">
        <div
          className="wf-canvas-grid"
          style={{
            gridTemplateColumns: `repeat(${totalColumns}, 240px)`,
            gridTemplateRows: `repeat(${Math.max(1, ...Object.values(layout.laneCount))}, auto)`,
          }}
        >
          {/* START terminal */}
          <TerminalCell
            kind="start"
            ref={(el) => { cardRefs.current[START_ID] = el }}
            column={1}
            running={runState.status === 'running'}
            done={runState.status === 'completed'}
          />

          {layout.cells.map((cell) => (
            <CardCell
              key={cell.step.id}
              ref={(el) => { cardRefs.current[cell.step.id] = el }}
              cell={cell}
              columnOffset={COLUMN_OFFSET}
              agent={agentMap.get(cell.step.agentId)}
              cardState={runState.cards[cell.step.id]}
              isOpen={openStepId === cell.step.id}
              onClick={() => setOpenStepId(cell.step.id === openStepId ? null : cell.step.id)}
            />
          ))}

          {/* END terminal */}
          <TerminalCell
            kind="end"
            ref={(el) => { cardRefs.current[END_ID] = el }}
            column={totalColumns}
            done={runState.status === 'completed'}
          />
        </div>

        <svg
          className="wf-edges"
          width={innerSize.w}
          height={innerSize.h}
          viewBox={`0 0 ${Math.max(1, innerSize.w)} ${Math.max(1, innerSize.h)}`}
          data-testid="wf-edges"
          preserveAspectRatio="none"
        >
          {/* START → entry step */}
          {entryId ? renderEdge(rects[START_ID], rects[entryId], START_ID, entryId, undefined, false, edgeClass) : null}

          {/* Real flow edges */}
          {layout.edges.map((edge, i) => renderEdge(
            rects[edge.from], rects[edge.to],
            edge.from, edge.to, edge.label, !!edge.isBackEdge,
            edgeClass, `e-${i}`,
          ))}

          {/* terminals → END */}
          {terminals.map((id) => renderEdge(
            rects[id], rects[END_ID],
            id, END_ID, undefined, false,
            edgeClass, `t-${id}`,
          ))}
        </svg>
      </div>

      {openStepId ? (
        <SidePanel
          stepId={openStepId}
          step={workflow.steps.find((s) => s.id === openStepId)!}
          agent={agentMap.get(workflow.steps.find((s) => s.id === openStepId)?.agentId ?? '')}
          cardState={runState.cards[openStepId]}
          onClose={() => setOpenStepId(null)}
        />
      ) : null}
    </div>
  )
}

function renderEdge(
  a: AnchorRect | undefined,
  b: AnchorRect | undefined,
  fromId: string,
  toId: string,
  label: string | undefined,
  isBackEdge: boolean,
  edgeClass: (from: string, to: string, label: string | undefined, back: boolean) => string,
  keyPrefix: string = `e-${fromId}-${toId}`,
): JSX.Element | null {
  if (!a || !b) return null
  const x1 = a.left + a.width
  const y1 = a.top + a.height / 2
  const x2 = b.left
  const y2 = b.top + b.height / 2
  const dx = Math.max(40, Math.abs(x2 - x1) / 2)
  const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
  const cls = edgeClass(fromId, toId, label, isBackEdge)
  const labelX = (x1 + x2) / 2
  const labelY = (y1 + y2) / 2 - 6
  return (
    <g
      key={`${keyPrefix}-${label ?? ''}`}
      data-testid={`wf-edge-${fromId}-${toId}${label ? '-' + label : ''}`}
      data-class={cls}
    >
      <path d={d} className={cls} />
      {label ? <text className="wf-edge-label" x={labelX} y={labelY}>{label}</text> : null}
    </g>
  )
}

interface CardCellProps {
  cell: LaidOutStep
  columnOffset: number
  agent: Agent | undefined
  cardState: CardState | undefined
  isOpen: boolean
  onClick: () => void
}

const CardCell = (() => {
  const Component = (props: CardCellProps & { cardRef?: (el: HTMLDivElement | null) => void }) => {
    const { cell, columnOffset, agent, cardState, isOpen, onClick, cardRef } = props
    const meta = agent ? AGENT_KIND_META[agent.kind] : null
    const Icon = agent && meta ? iconFor(meta.icon) : Icons.conductor
    const status = cardState?.status ?? 'idle'
    const decision = cardState?.decision ?? null
    const tailLine = cardState?.output ? tail(cardState.output) : ''
    const badge = status === 'completed' ? '✓' : status === 'failed' ? '✕' : status === 'running' ? '▸' : ''
    const style = meta
      ? ({ ['--k' as never]: meta.color, ['--kbg' as never]: meta.bg } as React.CSSProperties)
      : undefined
    return (
      <div
        ref={cardRef}
        className={`wf-card ${isOpen ? 'active' : ''}`}
        data-status={status}
        data-step-id={cell.step.id}
        data-testid={`wf-card-${cell.step.id}`}
        style={{
          ...style,
          gridColumn: cell.column + 1 + columnOffset,
          gridRow: cell.lane + 1,
        }}
        onClick={onClick}
      >
        {badge ? <span className="wf-card-badge" data-testid={`wf-card-badge-${cell.step.id}`}>{badge}</span> : null}
        <div className="wf-card-head">
          <span className="wf-card-icon"><Icon size={14} /></span>
          <span className="wf-card-title">{agent?.name ?? `(missing: ${cell.step.agentId})`}</span>
          <span className="wf-card-status"><span className="dot" /> {status}</span>
        </div>
        <div className="wf-card-meta">
          {agent ? `${agent.kind} · ${agent.model}` : 'unknown agent'}
        </div>
        {cell.step.note ? <div className="wf-card-note">{cell.step.note}</div> : null}
        {tailLine ? <div className="wf-card-tail" data-testid={`wf-card-tail-${cell.step.id}`}>{tailLine}</div> : null}
        {decision ? <span className="wf-card-decision" data-testid={`wf-card-decision-${cell.step.id}`}>DECISION: {decision}</span> : null}
      </div>
    )
  }
  return Object.assign(
    function Forwarded({ ref, ...rest }: CardCellProps & { ref?: (el: HTMLDivElement | null) => void }) {
      return <Component {...rest} cardRef={ref} />
    },
    { displayName: 'CardCell' },
  )
})()

interface TerminalCellProps {
  kind: 'start' | 'end'
  column: number
  running?: boolean
  done?: boolean
}

const TerminalCell = (() => {
  const Component = (props: TerminalCellProps & { cardRef?: (el: HTMLDivElement | null) => void }) => {
    const { kind, column, running, done, cardRef } = props
    const cls = `wf-terminal wf-terminal-${kind}${running ? ' running' : ''}${done ? ' done' : ''}`
    return (
      <div
        ref={cardRef}
        className={cls}
        data-testid={`wf-terminal-${kind}`}
        style={{ gridColumn: column, gridRow: 1, alignSelf: 'center' }}
      >
        <span className="wf-terminal-label">{kind === 'start' ? 'START' : 'END'}</span>
      </div>
    )
  }
  return Object.assign(
    function Forwarded({ ref, ...rest }: TerminalCellProps & { ref?: (el: HTMLDivElement | null) => void }) {
      return <Component {...rest} cardRef={ref} />
    },
    { displayName: 'TerminalCell' },
  )
})()

interface SidePanelProps {
  stepId: string
  step: WorkflowStep
  agent: Agent | undefined
  cardState: CardState | undefined
  onClose: () => void
}

function SidePanel({ stepId, step, agent, cardState, onClose }: SidePanelProps): JSX.Element {
  return (
    <div className="wf-side-panel" data-testid={`wf-side-panel-${stepId}`}>
      <div className="wf-side-panel-head">
        <span style={{ flex: 1 }}>{agent?.name ?? step.agentId} — {step.id}</span>
        <button className="btn btn-ghost small" onClick={onClose}>×</button>
      </div>
      <div className="wf-side-panel-body" data-testid={`wf-side-panel-body-${stepId}`}>
        {cardState?.output || <span style={{ opacity: 0.5 }}>No output yet.</span>}
      </div>
      <div className="wf-side-panel-foot">
        <span>status: {cardState?.status ?? 'idle'}</span>
        {cardState?.decision ? <span>decision: {cardState.decision}</span> : null}
        {cardState?.next ? <span>next: {cardState.next}</span> : null}
        {cardState?.error ? <span style={{ color: '#f87171' }}>error: {cardState.error}</span> : null}
      </div>
    </div>
  )
}
