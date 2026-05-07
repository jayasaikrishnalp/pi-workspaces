/**
 * WorkflowRunsStore v2 — agent-driven step rows.
 *
 * Spec:
 *   - createRun persists agent step rows with stable id, agentId, note,
 *     branches (JSON), next, plus the legacy step_kind='agent' / step_ref=agentId
 *     so v1 readers stay valid
 *   - listSteps returns rows in step_index order with v2 fields populated
 *   - finishStep persists status, output, error, decision, next; truncates
 *     output to OUTPUT_CAP (4096) bytes from the tail
 *   - setStepDecision(runId, idx, decision, next) persists both fields
 *   - appendStepOutput coalesces and tail-truncates
 *   - listRuns(undefined) returns recent across all workflows; listRuns('id')
 *     filters to that workflow id; activeRun returns only running/queued
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openDb } from '../src/server/db.ts'
import { WorkflowRunsStore } from '../src/server/workflow-runs-store.ts'

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runs-store-'))
  return { dir, db: openDb(path.join(dir, 'data.sqlite')) }
}

const SAMPLE_STEPS = [
  { id: 'triage', agentId: 'l1-triage-agent', note: 'Validate request' },
  {
    id: 'file-chg',
    agentId: 'servicenow-agent',
    note: 'File CHG, route to CAB',
    branches: { approve: 're-confirm', 'no-approve': 'end' },
  },
  { id: 're-confirm', agentId: 'l1-triage-agent', note: 'Re-confirm scope', next: 'terminate' },
  { id: 'terminate', agentId: 'aws-agent', note: 'Terminate' },
]

test('createRun persists agent step rows with v2 fields', () => {
  const { db } = tmpDb()
  const store = new WorkflowRunsStore(db)
  const run = store.createRun({
    id: 'run-1',
    workflow: 'wf-server-deletion',
    workflowName: 'Server Deletion Workflow',
    triggeredBy: 'operator',
    steps: SAMPLE_STEPS,
  })
  assert.equal(run.id, 'run-1')
  assert.equal(run.workflow, 'wf-server-deletion')
  assert.equal(run.workflow_name, 'Server Deletion Workflow')
  assert.equal(run.status, 'queued')
  assert.equal(run.step_count, 4)

  const steps = store.listSteps('run-1')
  assert.equal(steps.length, 4)
  // step 0 (triage)
  assert.equal(steps[0].step_index, 0)
  assert.equal(steps[0].step_id, 'triage')
  assert.equal(steps[0].step_agent_id, 'l1-triage-agent')
  assert.equal(steps[0].step_note, 'Validate request')
  assert.equal(steps[0].step_branches, null)
  assert.equal(steps[0].step_next, null)
  // legacy columns still populated for v1 readers
  assert.equal(steps[0].step_kind, 'agent')
  assert.equal(steps[0].step_ref, 'l1-triage-agent')
  // step 1 has branches
  assert.equal(steps[1].step_id, 'file-chg')
  assert.equal(steps[1].step_branches, JSON.stringify({ approve: 're-confirm', 'no-approve': 'end' }))
  assert.equal(steps[1].step_next, null)
  // step 2 has next
  assert.equal(steps[2].step_id, 're-confirm')
  assert.equal(steps[2].step_next, 'terminate')
})

test('finishStep writes status / output / decision / next', () => {
  const { db } = tmpDb()
  const store = new WorkflowRunsStore(db)
  store.createRun({ id: 'r2', workflow: 'wf-x', triggeredBy: null, steps: SAMPLE_STEPS })
  store.startStep('r2', 1, { piRunId: 'pi-abc-123' })
  store.finishStep('r2', 1, {
    status: 'completed',
    output: 'analysis complete\nDECISION: approve',
    decision: 'approve',
    next: 're-confirm',
  })
  const steps = store.listSteps('r2')
  const row = steps[1]
  assert.equal(row.status, 'completed')
  assert.equal(row.output, 'analysis complete\nDECISION: approve')
  assert.equal(row.step_decision, 'approve')
  assert.equal(row.step_next, 're-confirm')
  assert.equal(row.pi_run_id, 'pi-abc-123')
})

test('finishStep truncates output to last 4096 bytes', () => {
  const { db } = tmpDb()
  const store = new WorkflowRunsStore(db)
  store.createRun({ id: 'r3', workflow: 'wf-x', triggeredBy: null, steps: SAMPLE_STEPS })
  const big = 'A'.repeat(4096) + 'TAIL_' + 'B'.repeat(100)
  store.finishStep('r3', 0, { status: 'completed', output: big })
  const row = store.listSteps('r3')[0]
  assert.equal(row.output.length, 4096)
  assert.ok(row.output.endsWith('B'.repeat(100)))
})

test('setStepDecision overwrites decision and next', () => {
  const { db } = tmpDb()
  const store = new WorkflowRunsStore(db)
  store.createRun({ id: 'r4', workflow: 'wf-x', triggeredBy: null, steps: SAMPLE_STEPS })
  store.setStepDecision('r4', 1, 'no-approve', 'end')
  let row = store.listSteps('r4')[1]
  assert.equal(row.step_decision, 'no-approve')
  assert.equal(row.step_next, 'end')
  store.setStepDecision('r4', 1, null, null)
  row = store.listSteps('r4')[1]
  assert.equal(row.step_decision, null)
  assert.equal(row.step_next, null)
})

test('appendStepOutput coalesces and keeps the last 4KB', () => {
  const { db } = tmpDb()
  const store = new WorkflowRunsStore(db)
  store.createRun({ id: 'r5', workflow: 'wf-x', triggeredBy: null, steps: SAMPLE_STEPS })
  store.appendStepOutput('r5', 0, 'hello ')
  store.appendStepOutput('r5', 0, 'world')
  let row = store.listSteps('r5')[0]
  assert.equal(row.output, 'hello world')
  // overflow
  store.appendStepOutput('r5', 0, 'X'.repeat(5000))
  row = store.listSteps('r5')[0]
  assert.equal(row.output.length, 4096)
  assert.ok(row.output.startsWith('X')) // tail-only retained
})

test('listRuns supports both filtered and all-workflows modes', () => {
  const { db } = tmpDb()
  const store = new WorkflowRunsStore(db)
  store.createRun({ id: 'a1', workflow: 'wf-a', triggeredBy: null, steps: [SAMPLE_STEPS[0]] })
  store.createRun({ id: 'a2', workflow: 'wf-a', triggeredBy: null, steps: [SAMPLE_STEPS[0]] })
  store.createRun({ id: 'b1', workflow: 'wf-b', triggeredBy: null, steps: [SAMPLE_STEPS[0]] })
  const filtered = store.listRuns('wf-a')
  assert.equal(filtered.length, 2)
  assert.deepEqual(filtered.map((r) => r.id).sort(), ['a1', 'a2'])
  const all = store.listRuns(undefined)
  assert.equal(all.length, 3)
})

test('activeRun returns only running/queued', () => {
  const { db } = tmpDb()
  const store = new WorkflowRunsStore(db)
  store.createRun({ id: 'r1', workflow: 'wf-a', triggeredBy: null, steps: [SAMPLE_STEPS[0]] })
  // r1 is queued; should be active
  assert.equal(store.activeRun('wf-a')?.id, 'r1')
  store.setRunStatus('r1', 'completed')
  assert.equal(store.activeRun('wf-a'), null)
  store.createRun({ id: 'r2', workflow: 'wf-a', triggeredBy: null, steps: [SAMPLE_STEPS[0]] })
  store.setRunStatus('r2', 'running')
  assert.equal(store.activeRun('wf-a')?.id, 'r2')
})
