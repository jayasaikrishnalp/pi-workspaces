/**
 * FlowCanvas — React Flow (@xyflow/react) based workflow canvas.
 *
 * Three node types:
 *   - workflowInput  : the START node, displays workflow.inputs as fields
 *   - agent          : an agent step; renders header, role, model, status,
 *                      typed inputs/outputs and a `+` button on the right
 *                      that opens a popover to attach the next agent or end
 *   - workflowOutput : the END node, displays workflow.outputs and final status
 *
 * Layout seeding: when a step has no persisted `position`, we run the existing
 * column/lane layout from canvas-layout.ts to seed it. Once the user drags the
 * node, the new position is written back to workflow.steps[i].position so it
 * survives reload.
 *
 * Edge model: a single linear edge between consecutive steps (start →
 * step[0] → step[1] → ... → end) plus `branches` edges if present in the
 * workflow. Branch labels render on the edge mid-line.
 *
 * Adding nodes: each agent / start node renders a `+` source handle. Clicking
 * the handle opens an in-canvas popover with two actions:
 *   - "Add agent"  → attaches an agent picker; selecting an agent appends a
 *                    new step and sets it as the predecessor's `next`
 *   - "End flow"   → sets the predecessor's `next` to "end"
 */
import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow,
  applyNodeChanges, type Edge as RFEdge, type EdgeProps, type Node as RFNode, type NodeChange,
  type NodeProps, BaseEdge, getBezierPath, EdgeLabelRenderer, Handle, Position,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import '../../../styles/workflow-canvas.css'
import './flow-canvas.css'
import { Icons } from '../../icons/Icons'
import { layoutWorkflow } from './canvas-layout'
import type { Workflow, WorkflowStep, Field } from '../../../lib/workflows-store'
import { AGENT_KIND_META, type Agent } from '../../../lib/agents-store'
import type { CardState, RunState } from '../../../hooks/useWorkflowRun'

const COL_WIDTH = 300
const ROW_HEIGHT = 200
const ORIGIN_X = 60
const ORIGIN_Y = 80

interface Props {
  workflow: Workflow
  agents: Agent[]
  runState: RunState
  /** Caller commits the new workflow (positions, new steps, etc.). */
  onWorkflowChange: (w: Workflow) => void
  /** Open the side panel with full step detail. */
  onOpenStep: (stepId: string) => void
  /** Selected step id (if any). */
  selectedStepId: string | null
}

type StartNodeData = {
  kind: 'workflowInput'
  inputs: Field[]
  status: RunState['status']
  onAddNext: (anchor: HTMLElement | null) => void
  isLast: boolean
}
type EndNodeData = {
  kind: 'workflowOutput'
  outputs: Field[]
  status: RunState['status']
  finalCard: CardState | null
}
type AgentNodeData = {
  kind: 'agent'
  step: WorkflowStep
  agent: Agent | undefined
  cardState: CardState | undefined
  isSelected: boolean
  isLast: boolean
  onClick: () => void
  onAddNext: (anchor: HTMLElement | null) => void
}

type FlowNode =
  | RFNode<StartNodeData, 'workflowInput'>
  | RFNode<AgentNodeData, 'agent'>
  | RFNode<EndNodeData, 'workflowOutput'>

function iconFor(name: string) {
  const all = Icons as unknown as Record<string, (p: { size?: number }) => JSX.Element>
  return all[name] ?? all.swarm
}

/* ===== Node renderers ===== */

function StartNode({ data }: NodeProps<RFNode<StartNodeData, 'workflowInput'>>): JSX.Element {
  const { inputs, status, onAddNext, isLast } = data
  const running = status === 'running'
  const done = status === 'completed'
  return (
    <div className={`fc-node fc-node-start ${running ? 'is-running' : ''} ${done ? 'is-done' : ''}`}>
      <div className="fc-node-head">
        <span className="fc-node-iconwrap fc-node-iconwrap--start">
          <Icons.conductor size={14} />
        </span>
        <div className="fc-node-titles">
          <div className="fc-node-title">Workflow Input</div>
          <div className="fc-node-sub">external arguments — entrypoint</div>
        </div>
      </div>
      {inputs.length > 0 ? (
        <div className="fc-fields">
          {inputs.map((f) => (
            <div key={f.name} className="fc-field" title={f.desc ?? ''}>
              <span className="fc-field-name">{f.name}{f.required ? <span className="fc-required">*</span> : null}</span>
              <span className="fc-field-type">{f.type}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="fc-fields fc-fields--empty">no external inputs declared</div>
      )}

      {/* "+" affordance — only on the last node so adds always append. */}
      {isLast ? (
        <button
          className="fc-add-handle"
          aria-label="Add next step"
          onClick={(e) => {
            e.stopPropagation()
            onAddNext(e.currentTarget)
          }}
          data-testid="fc-add-after-start"
        >+</button>
      ) : null}

      <Handle type="source" position={Position.Right} className="fc-handle fc-handle-source" />
    </div>
  )
}

function EndNode({ data }: NodeProps<RFNode<EndNodeData, 'workflowOutput'>>): JSX.Element {
  const { outputs, status, finalCard } = data
  const done = status === 'completed'
  const failed = status === 'failed'
  const verdict = failed ? 'failed' : done ? 'success' : 'pending'
  return (
    <div className={`fc-node fc-node-end fc-verdict-${verdict}`}>
      <Handle type="target" position={Position.Left} className="fc-handle fc-handle-target" />
      <div className="fc-node-head">
        <span className="fc-node-iconwrap fc-node-iconwrap--end">
          <Icons.tasks size={14} />
        </span>
        <div className="fc-node-titles">
          <div className="fc-node-title">Workflow Output</div>
          <div className="fc-node-sub">final response · {verdict}</div>
        </div>
      </div>
      {outputs.length > 0 ? (
        <div className="fc-fields">
          {outputs.map((f) => (
            <div key={f.name} className="fc-field" title={f.desc ?? ''}>
              <span className="fc-field-name">{f.name}</span>
              <span className="fc-field-type">{f.type}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="fc-fields fc-fields--empty">no outputs declared</div>
      )}
      {finalCard?.error ? (
        <div className="fc-end-error">{finalCard.error}</div>
      ) : null}
    </div>
  )
}

function AgentNode({ data }: NodeProps<RFNode<AgentNodeData, 'agent'>>): JSX.Element {
  const { step, agent, cardState, isSelected, isLast, onClick, onAddNext } = data
  const meta = agent ? AGENT_KIND_META[agent.kind] : null
  const Icon = agent && meta ? iconFor(meta.icon) : Icons.conductor
  const status = cardState?.status ?? 'idle'
  const tail = cardState?.output ? cardState.output.replace(/\s+/g, ' ').trim().slice(-90) : ''
  const decision = cardState?.decision ?? null
  const cssVars = meta
    ? ({ ['--k' as never]: meta.color, ['--kbg' as never]: meta.bg } as React.CSSProperties)
    : undefined

  return (
    <div
      className={`fc-node fc-node-agent ${isSelected ? 'is-selected' : ''}`}
      data-status={status}
      style={cssVars}
      onClick={onClick}
      data-testid={`fc-node-${step.id}`}
    >
      <Handle type="target" position={Position.Left} className="fc-handle fc-handle-target" />

      <div className="fc-node-head">
        <span className="fc-node-iconwrap"><Icon size={14} /></span>
        <div className="fc-node-titles">
          <div className="fc-node-title">{agent?.name ?? `(missing: ${step.agentId})`}</div>
          <div className="fc-node-sub">
            {agent ? `${agent.kind} · ${agent.model}` : 'unknown agent'}
          </div>
        </div>
        <span className="fc-status-pill" data-status={status}>
          <span className="fc-status-dot" />
          {status}
        </span>
      </div>

      {agent?.inputs && agent.inputs.length > 0 ? (
        <div className="fc-section">
          <div className="fc-section-label">inputs</div>
          {agent.inputs.map((p) => (
            <div key={p.name} className="fc-field fc-field--in" title={p.desc ?? ''}>
              <span className="fc-pin-dot" data-side="in" />
              <span className="fc-field-name">{p.name}{p.required ? <span className="fc-required">*</span> : null}</span>
              <span className="fc-field-type">{p.type}</span>
            </div>
          ))}
        </div>
      ) : null}

      {agent?.outputs && agent.outputs.length > 0 ? (
        <div className="fc-section">
          <div className="fc-section-label">outputs</div>
          {agent.outputs.map((p) => (
            <div key={p.name} className="fc-field fc-field--out" title={p.desc ?? ''}>
              <span className="fc-field-type">{p.type}</span>
              <span className="fc-field-name">{p.name}</span>
              <span className="fc-pin-dot" data-side="out" />
            </div>
          ))}
        </div>
      ) : null}

      {step.note ? <div className="fc-note">{step.note}</div> : null}
      {tail ? <div className="fc-tail">…{tail}</div> : null}
      {decision ? <span className="fc-decision">DECISION: {decision}</span> : null}

      {isLast ? (
        <button
          className="fc-add-handle"
          aria-label="Add next step"
          onClick={(e) => {
            e.stopPropagation()
            onAddNext(e.currentTarget)
          }}
          data-testid={`fc-add-after-${step.id}`}
        >+</button>
      ) : null}

      <Handle type="source" position={Position.Right} className="fc-handle fc-handle-source" />
    </div>
  )
}

/* ===== Edge with optional branch label ===== */

function FlowEdge(props: EdgeProps): JSX.Element {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, label, style } = props
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  })
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className="fc-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

/* ===== Layout seeding ===== */

function seededPositions(workflow: Workflow): {
  startPos: { x: number; y: number }
  endPos: { x: number; y: number }
  stepPos: Record<string, { x: number; y: number }>
} {
  const layout = layoutWorkflow(workflow)
  const stepPos: Record<string, { x: number; y: number }> = {}
  const cols = layout.columnCount > 0 ? layout.columnCount : 1
  for (const cell of layout.cells) {
    stepPos[cell.step.id] = {
      x: ORIGIN_X + (cell.column + 1) * COL_WIDTH,
      y: ORIGIN_Y + cell.lane * ROW_HEIGHT,
    }
  }
  // Apply persisted overrides last so user drags win over auto-layout.
  for (const s of workflow.steps) {
    if (s.position) stepPos[s.id] = s.position
  }
  return {
    startPos: workflow.layout?.start ?? { x: ORIGIN_X, y: ORIGIN_Y },
    endPos: workflow.layout?.end ?? { x: ORIGIN_X + (cols + 1) * COL_WIDTH, y: ORIGIN_Y },
    stepPos,
  }
}

/* ===== Node + edge construction ===== */

function buildElements(
  workflow: Workflow,
  agents: Agent[],
  runState: RunState,
  selectedStepId: string | null,
  onOpenStep: (id: string) => void,
  onAddNext: (predecessorId: string, anchor: HTMLElement | null) => void,
): { nodes: FlowNode[]; edges: RFEdge[] } {
  const agentMap = new Map(agents.map((a) => [a.id, a]))
  const positions = seededPositions(workflow)
  const lastStepId = workflow.steps[workflow.steps.length - 1]?.id ?? null
  const nodes: FlowNode[] = []

  nodes.push({
    id: '__start__',
    type: 'workflowInput',
    position: positions.startPos,
    data: {
      kind: 'workflowInput',
      inputs: workflow.inputs ?? [],
      status: runState.status,
      onAddNext: (anchor) => onAddNext('__start__', anchor),
      isLast: workflow.steps.length === 0,
    },
    draggable: true,
  } as FlowNode)

  for (const step of workflow.steps) {
    const isLastStep = step.id === lastStepId
    nodes.push({
      id: step.id,
      type: 'agent',
      position: positions.stepPos[step.id] ?? { x: ORIGIN_X + COL_WIDTH, y: ORIGIN_Y },
      data: {
        kind: 'agent',
        step,
        agent: agentMap.get(step.agentId),
        cardState: runState.cards[step.id],
        isSelected: selectedStepId === step.id,
        isLast: isLastStep,
        onClick: () => onOpenStep(step.id),
        onAddNext: (anchor) => onAddNext(step.id, anchor),
      },
      draggable: true,
    } as FlowNode)
  }

  // END node — only render when at least one step exists OR the user has run
  // the workflow. (An empty workflow shows just START + the +button.)
  const lastCard = lastStepId ? runState.cards[lastStepId] : null
  if (workflow.steps.length > 0) {
    nodes.push({
      id: '__end__',
      type: 'workflowOutput',
      position: positions.endPos,
      data: {
        kind: 'workflowOutput',
        outputs: workflow.outputs ?? [],
        status: runState.status,
        finalCard: lastCard ?? null,
      },
      draggable: true,
    } as FlowNode)
  }

  // Edges — linear by default + branches.
  const edges: RFEdge[] = []
  const ids = new Set([...workflow.steps.map((s) => s.id), '__start__', '__end__'])
  if (workflow.steps[0]) {
    edges.push(makeEdge('__start__', workflow.steps[0].id, runState))
  }
  for (let i = 0; i < workflow.steps.length; i++) {
    const s = workflow.steps[i]!
    let routed = false
    if (s.branches) {
      for (const [label, target] of Object.entries(s.branches)) {
        const to = target === 'end' ? '__end__' : target
        if (ids.has(to)) {
          edges.push(makeEdge(s.id, to, runState, label))
          routed = true
        }
      }
    }
    if (s.next) {
      const to = s.next === 'end' ? '__end__' : s.next
      if (ids.has(to)) edges.push(makeEdge(s.id, to, runState))
      routed = true
    }
    if (!routed) {
      const dflt = workflow.steps[i + 1]?.id ?? '__end__'
      if (ids.has(dflt)) edges.push(makeEdge(s.id, dflt, runState))
    }
  }

  return { nodes, edges }
}

function makeEdge(from: string, to: string, runState: RunState, label?: string): RFEdge {
  let cls = ''
  const fromCard = runState.cards[from]
  if (from === '__start__' && (runState.status === 'running' || runState.status === 'completed')) cls = 'chosen'
  else if (to === '__end__' && fromCard?.status === 'completed') cls = 'chosen'
  else if (fromCard?.status === 'running') cls = 'active'
  else if (fromCard?.status === 'completed' && (label ? fromCard.decision === label : fromCard.next === to)) cls = 'chosen'
  else if (fromCard?.decision != null && label && fromCard.decision !== label) cls = 'ghost'

  return {
    id: `e-${from}-${to}-${label ?? ''}`,
    source: from,
    target: to,
    type: 'flow',
    label,
    className: cls,
    animated: cls === 'active',
  }
}

/* ===== Add-step popover ===== */

interface AddPopoverState {
  predecessorId: string
  anchorRect: DOMRect
}

function AddPopover({
  state, agents, onPick, onEnd, onClose,
}: {
  state: AddPopoverState
  agents: Agent[]
  onPick: (agent: Agent) => void
  onEnd: () => void
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Clamp popover to viewport so it stays clickable even when the anchor
  // sits near a screen edge.
  const POPOVER_W = 260
  const POPOVER_H = 320
  const naiveTop = state.anchorRect.top + state.anchorRect.height / 2 - 12
  const naiveLeft = state.anchorRect.right + 8
  const top = Math.max(8, Math.min(naiveTop, window.innerHeight - POPOVER_H - 8))
  const left = Math.max(8, Math.min(naiveLeft, window.innerWidth - POPOVER_W - 8))
  return (
    <div
      ref={ref}
      className="fc-popover"
      style={{ top, left }}
      data-testid="fc-add-popover"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="fc-popover-title">Add next step</div>
      <div className="fc-popover-list">
        {agents.length === 0 ? (
          <div className="fc-popover-empty">No agents in roster.</div>
        ) : (
          agents.map((a) => {
            const meta = AGENT_KIND_META[a.kind]
            const Icon = iconFor(meta.icon)
            return (
              <button
                key={a.id}
                className="fc-popover-row"
                onClick={() => onPick(a)}
                data-testid={`fc-popover-pick-${a.id}`}
                style={{ borderLeft: `2px solid ${meta.color}`, background: meta.bg }}
              >
                <Icon size={12} />
                <span>{a.name}</span>
                <span className="fc-popover-meta">{a.kind}</span>
              </button>
            )
          })
        )}
      </div>
      <div className="fc-popover-divider" />
      <button className="fc-popover-end" onClick={onEnd} data-testid="fc-popover-end">
        End the flow
      </button>
    </div>
  )
}

/* ===== Main ===== */

function InnerCanvas({
  workflow, agents, runState, onWorkflowChange, onOpenStep, selectedStepId,
}: Props): JSX.Element {
  const rf = useReactFlow()
  const [popover, setPopover] = useState<AddPopoverState | null>(null)
  // Track the last step id so we can pan to it after a structure change.
  const lastStepRef = useRef<string | null>(null)
  const onAddNext = useCallback((predecessorId: string, anchor: HTMLElement | null) => {
    if (!anchor) return
    setPopover({ predecessorId, anchorRect: anchor.getBoundingClientRect() })
  }, [])

  const { nodes, edges } = useMemo(
    () => buildElements(workflow, agents, runState, selectedStepId, onOpenStep, onAddNext),
    [workflow, agents, runState, selectedStepId, onOpenStep, onAddNext],
  )

  // Mutable copy so React Flow can drag without going through the store on every frame.
  const [liveNodes, setLiveNodes] = useState<FlowNode[]>(nodes)
  useEffect(() => { setLiveNodes(nodes) }, [nodes])

  // After the user APPENDS a step (last id changes from non-null to a new id),
  // pan to it. Skip the very first render so we don't fight fitView.
  useEffect(() => {
    const lastId = workflow.steps[workflow.steps.length - 1]?.id ?? null
    const prev = lastStepRef.current
    if (prev !== null && lastId && lastId !== prev) {
      const node = nodes.find((n) => n.id === lastId)
      if (node) {
        rf.setCenter(node.position.x + 130, node.position.y + 100, { zoom: 0.85, duration: 350 })
      }
    }
    lastStepRef.current = lastId
  }, [workflow.steps.length, nodes, rf])

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setLiveNodes((curr) => applyNodeChanges(changes, curr) as FlowNode[])
    // Persist on drag-stop.
    const stops = changes.filter((c) => c.type === 'position' && c.dragging === false)
    if (stops.length === 0) return
    let next = workflow
    for (const ch of stops) {
      if (ch.type !== 'position' || !ch.position) continue
      if (ch.id === '__start__') {
        next = { ...next, layout: { ...(next.layout ?? {}), start: ch.position } }
      } else if (ch.id === '__end__') {
        next = { ...next, layout: { ...(next.layout ?? {}), end: ch.position } }
      } else {
        next = {
          ...next,
          steps: next.steps.map((s) => (s.id === ch.id ? { ...s, position: ch.position } : s)),
        }
      }
    }
    if (next !== workflow) onWorkflowChange(next)
  }, [workflow, onWorkflowChange])

  const onPick = useCallback((agent: Agent) => {
    if (!popover) return
    const newId = `step-${workflow.steps.length + 1}-${Math.random().toString(36).slice(2, 5)}`
    const predecessor = popover.predecessorId
    const newStep: WorkflowStep = {
      id: newId,
      agentId: agent.id,
      note: agent.role || '',
    }
    // Place new step to the right of its predecessor.
    const lastNode = liveNodes.find((n) => n.id === predecessor)
    if (lastNode) newStep.position = { x: lastNode.position.x + COL_WIDTH, y: lastNode.position.y }

    let nextSteps = [...workflow.steps, newStep]
    // Fix predecessor's `next` to point at the new step (only if predecessor
    // isn't START — START always flows to steps[0] implicitly).
    if (predecessor !== '__start__') {
      nextSteps = nextSteps.map((s) =>
        s.id === predecessor && s.next === 'end' ? { ...s, next: newId } : s,
      )
    }
    onWorkflowChange({ ...workflow, steps: nextSteps })
    setPopover(null)
  }, [popover, workflow, liveNodes, onWorkflowChange])

  const onEnd = useCallback(() => {
    if (!popover) return
    const predecessor = popover.predecessorId
    if (predecessor === '__start__') {
      // No-op: empty workflow has no steps to terminate.
      setPopover(null)
      return
    }
    const nextSteps = workflow.steps.map((s) =>
      s.id === predecessor ? { ...s, next: 'end' as const } : s,
    )
    onWorkflowChange({ ...workflow, steps: nextSteps })
    setPopover(null)
  }, [popover, workflow, onWorkflowChange])

  return (
    <>
      <ReactFlow
        nodes={liveNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        nodeTypes={{ workflowInput: StartNode, agent: AgentNode, workflowOutput: EndNode }}
        edgeTypes={{ flow: FlowEdge }}
        defaultEdgeOptions={{ type: 'flow' }}
        defaultViewport={{ x: 0, y: 0, zoom: 0.85 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        nodesFocusable
        elementsSelectable
        selectNodesOnDrag={false}
        zoomOnDoubleClick={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="rgba(255,255,255,0.08)" />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          nodeColor={(n) => {
            const data = (n as FlowNode).data
            if (data.kind === 'workflowInput') return '#1dacfe'
            if (data.kind === 'workflowOutput') return '#7ac88c'
            const agent = (data as AgentNodeData).agent
            return agent ? AGENT_KIND_META[agent.kind].color : '#666'
          }}
          maskColor="rgba(12,13,16,0.7)"
          style={{ background: 'rgba(20,22,28,0.8)' }}
        />
      </ReactFlow>
      {popover ? (
        <AddPopover
          state={popover}
          agents={agents}
          onPick={onPick}
          onEnd={onEnd}
          onClose={() => setPopover(null)}
        />
      ) : null}
    </>
  )
}

export function FlowCanvas(props: Props): JSX.Element {
  return (
    <ReactFlowProvider>
      <InnerCanvas {...props} />
    </ReactFlowProvider>
  )
}
