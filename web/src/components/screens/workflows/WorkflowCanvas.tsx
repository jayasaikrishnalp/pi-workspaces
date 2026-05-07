/**
 * WorkflowCanvas — Railway-style grid of agent cards connected by faint
 * dotted SVG curves. Live status driven by useWorkflowRun's SSE-fed state.
 *
 * Layout strategy (no graph layout library):
 *   1. canvas-layout.ts assigns each step to (column, lane)
 *   2. We render cards in a CSS grid (auto-flow column, fixed-width columns)
 *   3. After mount, an absolutely-positioned SVG overlay measures every
 *      card's bounding rect and draws cubic Bézier paths between source
 *      right-center and target left-center
 *   4. ResizeObserver re-measures on container resize
 *
 * Card visual states are driven by CardState.status from the run hook;
 * edges highlight based on the run's progress (active → chosen → ghost).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

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

function iconFor(name: string) {
  const all = Icons as unknown as Record<string, (p: { size?: number }) => JSX.Element>
  return all[name] ?? all.swarm
}

function tail(text: string, n = 80): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= n) return compact
  return '…' + compact.slice(-n + 1)
}

export function WorkflowCanvas({ workflow, agents, runState, onCancel }: Props): JSX.Element {
  void onCancel
  const layout: Layout = useMemo(() => layoutWorkflow(workflow), [workflow])
  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents])

  const containerRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [rects, setRects] = useState<Record<string, AnchorRect>>({})
  const [openStepId, setOpenStepId] = useState<string | null>(null)

  // Re-measure on layout change + resize.
  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current
      if (!container) return
      const containerRect = container.getBoundingClientRect()
      const next: Record<string, AnchorRect> = {}
      for (const [id, el] of Object.entries(cardRefs.current)) {
        if (!el) continue
        const r = el.getBoundingClientRect()
        next[id] = {
          left: r.left - containerRect.left + container.scrollLeft,
          top: r.top - containerRect.top + container.scrollTop,
          width: r.width,
          height: r.height,
        }
      }
      setRects(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
    window.addEventListener('resize', measure)
    return () => { ro.disconnect(); window.removeEventListener('resize', measure) }
  }, [layout])

  // Compute SVG canvas size from max card extents.
  const svgSize = useMemo(() => {
    const values = Object.values(rects)
    if (values.length === 0) return { w: 0, h: 0 }
    let maxX = 0, maxY = 0
    for (const r of values) {
      if (r.left + r.width > maxX) maxX = r.left + r.width
      if (r.top + r.height > maxY) maxY = r.top + r.height
    }
    return { w: maxX + 80, h: maxY + 80 }
  }, [rects])

  // Edge classification for the run state.
  const edgeClass = (fromId: string, toId: string, branchKey: string | undefined, isBackEdge: boolean): string => {
    const cls: string[] = []
    if (isBackEdge) cls.push('back')
    const fromCard = runState.cards[fromId]
    if (fromCard) {
      // Branch decision tree.
      if (branchKey) {
        if (fromCard.decision != null) {
          if (fromCard.decision === branchKey) cls.push('chosen')
          else cls.push('ghost')
        }
      } else {
        // No branch label = explicit/default next.
        // It's "chosen" if the source completed AND its decision didn't pick a branch
        // OR if the source has no branches at all.
        if (fromCard.status === 'completed' && fromCard.next === toId) cls.push('chosen')
      }
      if (fromCard.status === 'running') cls.push('active')
    }
    return cls.join(' ')
  }

  // Cycles banner.
  const cycleBanner = layout.cycles.length > 0
    ? `Workflow contains a cycle (${layout.cycles.join(', ')}). Edges highlighted in amber.`
    : null

  return (
    <div className="wf-canvas" ref={containerRef} data-testid="wf-canvas">
      {cycleBanner ? <div className="wf-canvas-banner">⚠ {cycleBanner}</div> : null}
      {runState.error ? <div className="wf-canvas-banner err">⚠ {runState.error}</div> : null}

      <div
        className="wf-canvas-grid"
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, layout.columnCount)}, 240px)`,
          gridTemplateRows: `repeat(${Math.max(1, ...Object.values(layout.laneCount))}, auto)`,
        }}
      >
        {layout.cells.map((cell) => (
          <CardCell
            key={cell.step.id}
            ref={(el) => { cardRefs.current[cell.step.id] = el }}
            cell={cell}
            agent={agentMap.get(cell.step.agentId)}
            cardState={runState.cards[cell.step.id]}
            isOpen={openStepId === cell.step.id}
            onClick={() => setOpenStepId(cell.step.id === openStepId ? null : cell.step.id)}
          />
        ))}
      </div>

      <svg
        className="wf-edges"
        width={svgSize.w}
        height={svgSize.h}
        viewBox={`0 0 ${svgSize.w} ${svgSize.h}`}
        data-testid="wf-edges"
      >
        {layout.edges.map((edge, i) => {
          const a = rects[edge.from]
          const b = rects[edge.to]
          if (!a || !b) return null
          const x1 = a.left + a.width
          const y1 = a.top + a.height / 2
          const x2 = b.left
          const y2 = b.top + b.height / 2
          const dx = Math.max(40, Math.abs(x2 - x1) / 2)
          const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
          const cls = edgeClass(edge.from, edge.to, edge.label, !!edge.isBackEdge)
          const labelX = (x1 + x2) / 2
          const labelY = (y1 + y2) / 2 - 6
          return (
            <g key={`e-${i}-${edge.from}-${edge.to}-${edge.label ?? ''}`} data-testid={`wf-edge-${edge.from}-${edge.to}${edge.label ? '-' + edge.label : ''}`} data-class={cls}>
              <path d={d} className={cls} />
              {edge.label ? (
                <text className="wf-edge-label" x={labelX} y={labelY}>{edge.label}</text>
              ) : null}
            </g>
          )
        })}
      </svg>

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

interface CardCellProps {
  cell: LaidOutStep
  agent: Agent | undefined
  cardState: CardState | undefined
  isOpen: boolean
  onClick: () => void
}

const CardCell = (() => {
  const Component = (props: CardCellProps & { cardRef?: (el: HTMLDivElement | null) => void }) => {
    const { cell, agent, cardState, isOpen, onClick, cardRef } = props
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
          gridColumn: cell.column + 1,
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
