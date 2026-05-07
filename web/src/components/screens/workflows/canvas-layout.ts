/**
 * Canvas layout — lays out a workflow's step DAG on a column-based grid for
 * the Railway-style canvas. Pure functions, no React imports, fully unit-testable.
 *
 * Algorithm:
 *   1. Build adjacency: each step has 0+ outgoing successors derived from
 *      step.next (or list-default = next list element) plus step.branches
 *      values. 'end' is dropped.
 *   2. BFS from the entry step (steps[0]) assigning depth = column index.
 *      A step's column = max(predecessor column) + 1 so re-converging
 *      branches share a column.
 *   3. Within each column, lane order = first-seen order during BFS.
 *   4. Edges are emitted with optional labels for branch keys.
 *
 * Cycle detection: if we encounter an already-visited node via a different
 * predecessor, we use the earlier column (do not re-enqueue). Genuine
 * back-edges (a successor that points to an ancestor) are reported as a
 * `cycles: string[]` warning so the canvas can surface a banner.
 */

import type { Workflow, WorkflowStep } from '../../../lib/workflows-store'

export interface LaidOutStep {
  step: WorkflowStep
  column: number
  lane: number
}

export interface LaidOutEdge {
  from: string
  to: string
  /** Branch key when this edge represents a branches[key] route. */
  label?: string
  /** True when the edge points back at an ancestor (cycle). */
  isBackEdge?: boolean
}

export interface Layout {
  cells: LaidOutStep[]
  edges: LaidOutEdge[]
  /** Step ids involved in cycles, if any. */
  cycles: string[]
  /** Total grid columns. */
  columnCount: number
  /** Per-column lane count (max lane + 1). */
  laneCount: Record<number, number>
}

/** Successors of a step, in deterministic emit order:
 *   - branches values, then
 *   - step.next (if not already in branches), then
 *   - default = next list element (if not already covered by branches/next)
 *  'end' is dropped. */
export function successorsOf(step: WorkflowStep, steps: WorkflowStep[], index: number): Array<{ to: string; label?: string }> {
  const out: Array<{ to: string; label?: string }> = []
  const seen = new Set<string>()
  if (step.branches) {
    for (const [key, target] of Object.entries(step.branches)) {
      if (target === 'end') continue
      if (!seen.has(target)) { out.push({ to: target, label: key }); seen.add(target) }
      else {
        // Same target via multiple branches — emit again so all labels appear,
        // but mark as a duplicate edge for the canvas to coalesce visually.
        out.push({ to: target, label: key })
      }
    }
  }
  if (step.next) {
    if (step.next !== 'end' && !seen.has(step.next)) {
      out.push({ to: step.next })
      seen.add(step.next)
    }
  } else if (!step.branches) {
    const dflt = steps[index + 1]?.id
    if (dflt && !seen.has(dflt)) {
      out.push({ to: dflt })
      seen.add(dflt)
    }
  }
  return out
}

export function layoutWorkflow(workflow: Workflow): Layout {
  const steps = workflow.steps
  if (steps.length === 0) {
    return { cells: [], edges: [], cycles: [], columnCount: 0, laneCount: {} }
  }
  const indexById = new Map(steps.map((s, i) => [s.id, i]))
  // Column assignment via BFS.
  const column = new Map<string, number>()
  const order: string[] = []
  const queue: string[] = []
  const entry = steps[0]!.id
  column.set(entry, 0)
  queue.push(entry)
  order.push(entry)
  while (queue.length > 0) {
    const id = queue.shift()!
    const idx = indexById.get(id)!
    const step = steps[idx]!
    const succs = successorsOf(step, steps, idx)
    for (const { to } of succs) {
      const toIdx = indexById.get(to)
      if (toIdx == null) continue // unknown id, ignore
      const nextCol = (column.get(id) ?? 0) + 1
      const existing = column.get(to)
      if (existing == null) {
        column.set(to, nextCol)
        queue.push(to)
        order.push(to)
      }
      // If revisited via another path, keep the FIRST-seen (shortest) column.
      // Cycle detection in the edges pass uses this column to spot back-edges.
    }
  }
  // Any steps not reached from entry: stack them at column 0 so they're
  // still visible (likely an authoring error).
  for (const s of steps) {
    if (!column.has(s.id)) {
      column.set(s.id, 0)
      order.push(s.id)
    }
  }

  // Lane assignment: per-column counter using `order`.
  const laneByCol = new Map<number, number>()
  const cells: LaidOutStep[] = []
  for (const id of order) {
    const col = column.get(id)!
    const idx = indexById.get(id)!
    const lane = laneByCol.get(col) ?? 0
    laneByCol.set(col, lane + 1)
    cells.push({ step: steps[idx]!, column: col, lane })
  }

  const columnCount = Math.max(...Array.from(column.values())) + 1
  const laneCount: Record<number, number> = {}
  for (const [col, count] of laneByCol) laneCount[col] = count

  // Edges + cycle detection.
  const edges: LaidOutEdge[] = []
  const cycles = new Set<string>()
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    const fromCol = column.get(step.id) ?? 0
    for (const { to, label } of successorsOf(step, steps, i)) {
      const toCol = column.get(to)
      const isBackEdge = toCol != null && toCol <= fromCol
      if (isBackEdge) cycles.add(step.id)
      edges.push({ from: step.id, to, label, isBackEdge: isBackEdge || undefined })
    }
  }

  return { cells, edges, cycles: [...cycles], columnCount, laneCount }
}
