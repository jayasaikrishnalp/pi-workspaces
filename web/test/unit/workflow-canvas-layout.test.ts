import { describe, it, expect } from 'vitest'

import { layoutWorkflow, successorsOf } from '../../src/components/screens/workflows/canvas-layout'
import type { Workflow } from '../../src/lib/workflows-store'

const SERVER_DELETION: Workflow = {
  id: 'wf-server-deletion',
  name: 'Server Deletion',
  task: '',
  createdAt: '2026-05-07T00:00:00Z',
  steps: [
    { id: 'triage', agentId: 'l1', note: '' },
    { id: 'file-chg', agentId: 'snow', note: '', branches: { approve: 're-confirm', 'no-approve': 'end' } },
    { id: 're-confirm', agentId: 'l1', note: '' },
    { id: 'terminate', agentId: 'aws', note: '' },
  ],
}

describe('successorsOf', () => {
  it('emits next-default when no branches/next', () => {
    expect(successorsOf(SERVER_DELETION.steps[0], SERVER_DELETION.steps, 0))
      .toEqual([{ to: 'file-chg' }])
  })
  it('emits branches and skips end targets', () => {
    expect(successorsOf(SERVER_DELETION.steps[1], SERVER_DELETION.steps, 1))
      .toEqual([{ to: 're-confirm', label: 'approve' }])
  })
  it('emits explicit next when present, no default', () => {
    const step = { id: 's', agentId: 'a', next: 'terminate' }
    const list = [step, ...SERVER_DELETION.steps]
    expect(successorsOf(step, list, 0)).toEqual([{ to: 'terminate' }])
  })
})

describe('layoutWorkflow', () => {
  it('lays Server Deletion out as 4 columns 0..3', () => {
    const layout = layoutWorkflow(SERVER_DELETION)
    const byId = Object.fromEntries(layout.cells.map((c) => [c.step.id, c]))
    expect(byId.triage.column).toBe(0)
    expect(byId['file-chg'].column).toBe(1)
    expect(byId['re-confirm'].column).toBe(2)
    expect(byId.terminate.column).toBe(3)
    expect(layout.columnCount).toBe(4)
    expect(layout.cycles).toEqual([])
  })

  it('emits the approve branch edge with its label', () => {
    const layout = layoutWorkflow(SERVER_DELETION)
    const e = layout.edges.find((x) => x.from === 'file-chg' && x.to === 're-confirm')
    expect(e?.label).toBe('approve')
  })

  it('detects a back-edge as a cycle', () => {
    const cyc: Workflow = {
      id: 'wf-cyc',
      name: 'cyc', task: '', createdAt: 'x',
      steps: [
        { id: 'a', agentId: 'A' },
        { id: 'b', agentId: 'B', next: 'a' }, // back-edge
      ],
    }
    const layout = layoutWorkflow(cyc)
    expect(layout.cycles).toContain('b')
    const back = layout.edges.find((e) => e.from === 'b' && e.to === 'a')
    expect(back?.isBackEdge).toBe(true)
  })

  it('places re-converging branches in the deeper column', () => {
    const wf: Workflow = {
      id: 'wf-merge', name: 'merge', task: '', createdAt: 'x',
      steps: [
        { id: 'pick', agentId: 'P', branches: { left: 'l1', right: 'r1' } },
        { id: 'l1', agentId: 'L', next: 'merge' },
        { id: 'r1', agentId: 'R', next: 'merge' },
        { id: 'merge', agentId: 'M' },
      ],
    }
    const layout = layoutWorkflow(wf)
    const byId = Object.fromEntries(layout.cells.map((c) => [c.step.id, c]))
    expect(byId.pick.column).toBe(0)
    expect(byId.l1.column).toBe(1)
    expect(byId.r1.column).toBe(1)
    // merge has predecessors in col 1, so col 2.
    expect(byId.merge.column).toBe(2)
  })

  it('handles empty workflows', () => {
    const layout = layoutWorkflow({ id: 'e', name: 'e', task: '', createdAt: 'x', steps: [] })
    expect(layout.cells).toEqual([])
    expect(layout.edges).toEqual([])
    expect(layout.columnCount).toBe(0)
  })

  it('places unreachable steps at column 0', () => {
    const wf: Workflow = {
      id: 'orphan', name: 'orphan', task: '', createdAt: 'x',
      steps: [
        { id: 'a', agentId: 'A', next: 'end' },
        { id: 'b', agentId: 'B' }, // unreachable from a
      ],
    }
    const layout = layoutWorkflow(wf)
    const byId = Object.fromEntries(layout.cells.map((c) => [c.step.id, c]))
    expect(byId.a.column).toBe(0)
    expect(byId.b.column).toBe(0)
  })
})
