/**
 * Axial-coordinate hex math + an auto-layout that places nodes in a
 * deterministic spiral starting at (0,0).
 *
 * Design source: /tmp/cloudops-design-v2/pi-workspaces/project/src/hexgraph.jsx.
 * The original prototype hardcoded q/r per skill name. We need to handle
 * arbitrary topology (skills + agents + workflows + souls), so we sort
 * nodes by importance (degree, then kind, then name) and place them in
 * spiral order.
 */

export const HEX_W = 96
export const HEX_H = 110
export const ROW_OFFSET = 48
export const COL_OFFSET = 84

export interface AxialCoord { q: number; r: number }
export interface PixelCoord { x: number; y: number }

/**
 * Convert axial coordinates to a (x,y) pixel position. Mirrors the
 * design's `hexPos`.
 */
export function hexPos({ q, r }: AxialCoord): PixelCoord {
  const x = q * COL_OFFSET + (r % 2 ? COL_OFFSET / 2 : 0)
  const y = r * ROW_OFFSET
  return { x, y }
}

export interface LayoutNode<T> {
  /** opaque payload (whatever the caller wants on the node). */
  data: T
  q: number
  r: number
  x: number
  y: number
}

/**
 * Spiral hex coordinates around (0,0). Position 0 is the center; positions
 * 1..6 are ring 1; 7..18 are ring 2; etc.
 *
 * Ring k (k>=1) has 6k hexes. We walk the ring by stepping along the 6
 * cardinal directions, k steps each.
 */
const HEX_DIRS: AxialCoord[] = [
  { q: +1, r:  0 },
  { q:  0, r: +1 },
  { q: -1, r: +1 },
  { q: -1, r:  0 },
  { q:  0, r: -1 },
  { q: +1, r: -1 },
]

export function spiralHex(index: number): AxialCoord {
  if (index === 0) return { q: 0, r: 0 }
  let ring = 1
  let total = 1
  while (total + 6 * ring <= index) { total += 6 * ring; ring++ }
  const k = ring
  const offset = index - total
  // Start at the top-left of the ring (k steps from center along direction 4).
  let q = HEX_DIRS[4]!.q * k
  let r = HEX_DIRS[4]!.r * k
  // Walk the perimeter: 6 sides, k steps each.
  let step = 0
  for (let side = 0; side < 6; side++) {
    for (let s = 0; s < k; s++) {
      if (step === offset) return { q, r }
      const dir = HEX_DIRS[side]!
      q += dir.q
      r += dir.r
      step++
    }
  }
  return { q, r }
}

/**
 * Sort nodes by importance (descending degree, then kind precedence, then
 * name) and assign each one a spiral hex slot. Returns enriched nodes with
 * q/r/x/y.
 *
 * Deterministic — same input → same output. No physics, no jitter.
 */
export interface AutoLayoutInput<T> {
  nodes: T[]
  /** key for the node — must be unique. */
  keyOf: (n: T) => string
  /** kind precedence — higher = more central. */
  kindOf: (n: T) => string
  /** edges, used for degree ranking. */
  edges?: Array<{ source: string; target: string }>
}

const KIND_PRECEDENCE: Record<string, number> = {
  skill: 0, agent: 1, workflow: 2, soul: 3, memory: 4,
}

export function autoLayout<T>(input: AutoLayoutInput<T>): Array<LayoutNode<T>> {
  const degree = new Map<string, number>()
  for (const e of input.edges ?? []) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }
  const ordered = [...input.nodes].sort((a, b) => {
    const da = degree.get(input.keyOf(a)) ?? 0
    const db = degree.get(input.keyOf(b)) ?? 0
    if (da !== db) return db - da
    const ka = KIND_PRECEDENCE[input.kindOf(a)] ?? 99
    const kb = KIND_PRECEDENCE[input.kindOf(b)] ?? 99
    if (ka !== kb) return ka - kb
    return input.keyOf(a).localeCompare(input.keyOf(b))
  })
  return ordered.map((n, i) => {
    const { q, r } = spiralHex(i)
    const { x, y } = hexPos({ q, r })
    return { data: n, q, r, x, y }
  })
}

/**
 * Compute the bounding box of laid-out nodes. Used to size the SVG canvas.
 */
export function layoutBounds<T>(nodes: Array<LayoutNode<T>>): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: HEX_W, maxY: HEX_H, width: HEX_W, height: HEX_H }
  const xs = nodes.map((n) => n.x)
  const ys = nodes.map((n) => n.y)
  const padX = HEX_W
  const padY = HEX_H
  const minX = Math.min(...xs) - padX
  const minY = Math.min(...ys) - padY
  const maxX = Math.max(...xs) + padX
  const maxY = Math.max(...ys) + padY
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
}
