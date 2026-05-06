import { useMemo, useRef, useState, useCallback, type PointerEvent as RP } from 'react'

import type { SkillEdge, SkillNode } from '../../lib/api'
import { autoLayout, layoutBounds, type LayoutNode } from '../../lib/hexLayout'

const SKILL_COLORS: Record<string, { stop1: string; stop2: string }> = {
  skill:    { stop1: '#1dacfe', stop2: '#27ddf3' },
  agent:    { stop1: '#22c55e', stop2: '#5eead4' },
  workflow: { stop1: '#a855f7', stop2: '#ec4899' },
  soul:     { stop1: '#f97316', stop2: '#facc15' },
  default:  { stop1: '#1dacfe', stop2: '#A5FECB' },
}

interface Props {
  nodes: SkillNode[]
  edges: SkillEdge[]
  onSelect?: (n: SkillNode | null) => void
  selected?: SkillNode | null
  newNodeId?: string | null
}

const HEX_PATH = 'M 0 -55 L 47 -27 L 47 27 L 0 55 L -47 27 L -47 -27 Z'

function HexTile({
  node, layout, onClick, isActive, isNew, onHoverChange, onDragMove, onDragEnd,
}: {
  node: SkillNode
  layout: { x: number; y: number }
  onClick?: (n: SkillNode) => void
  isActive: boolean
  isNew: boolean
  onHoverChange?: (n: SkillNode | null) => void
  onDragMove?: (dx: number, dy: number) => void
  onDragEnd?: () => void
}): JSX.Element {
  const palette = SKILL_COLORS[node.source] ?? SKILL_COLORS.default!
  const id = `g-${node.name.replace(/[^a-z0-9]/gi, '-')}`
  const dragRef = useRef({ active: false, sx: 0, sy: 0, moved: false })

  const onPointerDown = (e: RP<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { active: true, sx: e.clientX, sy: e.clientY, moved: false }
  }
  const onPointerMove = (e: RP<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d.active) return
    const dx = e.clientX - d.sx; const dy = e.clientY - d.sy
    if (!d.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) d.moved = true
    if (d.moved) onDragMove?.(dx, dy)
  }
  const onPointerUp = () => {
    const d = dragRef.current
    dragRef.current = { active: false, sx: 0, sy: 0, moved: false }
    if (d.moved) onDragEnd?.()
    else onClick?.(node)
  }

  return (
    <div
      data-testid={`hex-${node.name}`}
      data-active={isActive ? 'true' : undefined}
      data-source={node.source}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseEnter={() => onHoverChange?.(node)}
      onMouseLeave={() => onHoverChange?.(null)}
      style={{
        position: 'absolute',
        left: layout.x, top: layout.y, width: 100, height: 110,
        transform: 'translate(-50%, -50%)',
        cursor: 'grab',
        touchAction: 'none',
        filter: isActive ? 'drop-shadow(0 0 20px var(--accent-cyan))' : 'none',
        animation: isNew ? 'hex-pop .9s cubic-bezier(.2,.8,.2,1) both' : undefined,
      }}>
      <svg width="100" height="110" viewBox="-50 -55 100 110" style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id={id} x1="0" y1="-55" x2="0" y2="55">
            <stop offset="0%"   stopColor={palette.stop1} stopOpacity="0.35" />
            <stop offset="100%" stopColor={palette.stop2} stopOpacity="0.10" />
          </linearGradient>
          <linearGradient id={`${id}-stroke`} x1="0" y1="-55" x2="0" y2="55">
            <stop offset="0%"   stopColor={palette.stop1} />
            <stop offset="100%" stopColor={palette.stop2} />
          </linearGradient>
        </defs>
        {isNew ? (
          <path d={HEX_PATH} fill="none" stroke={palette.stop2} strokeWidth="3" opacity="0.5"
                style={{ animation: 'ring-out 1.2s ease-out both' }} />
        ) : null}
        <path d={HEX_PATH}
              fill={`url(#${id})`}
              stroke={`url(#${id}-stroke)`}
              strokeWidth={isActive ? 2 : 1.4}
              opacity={isActive ? 1 : 0.92} />
        <path d={HEX_PATH} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1" transform="scale(0.86)" />
      </svg>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        textAlign: 'center', padding: '0 8px',
        pointerEvents: 'none',
      }}>
        <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-secondary)', lineHeight: 1 }}>
          {node.source}
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, marginTop: 4, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', maxWidth: 80, lineHeight: 1.15, textOverflow: 'ellipsis', overflow: 'hidden' }}>
          {node.name}
        </div>
      </div>
    </div>
  )
}

function HexEdges({
  edges, positions, hoveredName, width, height,
}: {
  edges: SkillEdge[]
  positions: Map<string, { x: number; y: number }>
  hoveredName: string | null
  width: number; height: number
}): JSX.Element {
  return (
    <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
         width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id="edge-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%"   stopColor="var(--accent)"      stopOpacity="0.0" />
          <stop offset="50%"  stopColor="var(--accent-cyan)" stopOpacity="0.6" />
          <stop offset="100%" stopColor="var(--accent)"      stopOpacity="0.0" />
        </linearGradient>
      </defs>
      {edges.map((e, i) => {
        const a = positions.get(e.source)
        const b = positions.get(e.target)
        if (!a || !b) return null
        const isHot = hoveredName != null && (hoveredName === e.source || hoveredName === e.target)
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2 - 16
        const d = `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`
        const dash = e.kind === 'link' ? '4 6' : e.kind === 'embodies' ? '2 4' : 'none'
        return (
          <g key={`${e.source}-${e.target}-${e.kind}-${i}`}>
            <path d={d} fill="none"
                  stroke={isHot ? 'var(--accent-cyan)' : 'url(#edge-grad)'}
                  strokeWidth={isHot ? 1.6 : 1}
                  opacity={isHot ? 1 : 0.55}
                  strokeDasharray={dash}
                  data-edge-kind={e.kind} />
          </g>
        )
      })}
    </svg>
  )
}

export function HexGraph({ nodes, edges, onSelect, selected, newNodeId }: Props): JSX.Element {
  const laid = useMemo(() => autoLayout({
    nodes, keyOf: (n) => n.name, kindOf: (n) => n.source, edges,
  }), [nodes, edges])
  const bounds = useMemo(() => layoutBounds(laid), [laid])

  const [drag, setDrag] = useState<Record<string, { dx: number; dy: number }>>({})
  const [hovered, setHovered] = useState<string | null>(null)
  const startDragRef = useRef<Record<string, { dx: number; dy: number }>>({})

  const positionsByName = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>()
    for (const n of laid) {
      const off = drag[n.data.name] ?? { dx: 0, dy: 0 }
      m.set(n.data.name, { x: n.x - bounds.minX + off.dx, y: n.y - bounds.minY + off.dy })
    }
    return m
  }, [laid, bounds, drag])

  const handleHover = useCallback((node: SkillNode | null) => {
    setHovered(node ? node.name : null)
  }, [])

  if (nodes.length === 0) {
    return (
      <div className="hexgraph-empty" data-testid="hexgraph-empty">
        <span className="kk-label-tiny">knowledge graph</span>
        <h3>No skills yet.</h3>
        <p>Create a skill via <code>POST /api/skills</code> or save one from a chat reply — it appears here in the next render.</p>
      </div>
    )
  }

  return (
    <div className="hexgraph" data-testid="hexgraph"
         style={{ position: 'relative', width: bounds.width, height: bounds.height, margin: '0 auto' }}>
      <HexEdges edges={edges} positions={positionsByName} hoveredName={hovered}
                width={bounds.width} height={bounds.height} />
      {laid.map((n: LayoutNode<SkillNode>) => {
        const pos = positionsByName.get(n.data.name)!
        return (
          <HexTile
            key={n.data.name}
            node={n.data}
            layout={pos}
            isActive={hovered === n.data.name || selected?.name === n.data.name}
            isNew={newNodeId === n.data.name}
            onHoverChange={handleHover}
            onClick={(node) => onSelect?.(node)}
            onDragMove={(dx, dy) => {
              const start = startDragRef.current[n.data.name] ?? (drag[n.data.name] ?? { dx: 0, dy: 0 })
              if (!startDragRef.current[n.data.name]) startDragRef.current[n.data.name] = start
              setDrag((prev) => ({ ...prev, [n.data.name]: { dx: start.dx + dx, dy: start.dy + dy } }))
            }}
            onDragEnd={() => { delete startDragRef.current[n.data.name] }}
          />
        )
      })}
    </div>
  )
}
