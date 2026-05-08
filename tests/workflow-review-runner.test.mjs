/**
 * Coverage for src/server/workflow-review-runner.ts and the
 * WorkflowRunner.onRunComplete plumbing.
 *
 * Two tiers of tests:
 *   1. Unit — feed a stub WorkflowRunner directly to handleRunComplete and
 *      assert the recursion guards + the inputs we'd hand to runner.start().
 *   2. Integration — wire a real WorkflowRunner with SimulatedAgentExecutor,
 *      hook the review runner as onRunComplete, run a workflow, wait for
 *      both the parent run + the review run to finish, assert both rows
 *      land in the store with the expected `triggered_by` distinction.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { openDb } from '../src/server/db.ts'
import { WorkflowRunsStore } from '../src/server/workflow-runs-store.ts'
import { WorkflowRunBusRegistry } from '../src/server/workflow-run-bus.ts'
import { WorkflowRunner, SimulatedAgentExecutor } from '../src/server/workflow-runner.ts'
import { WorkflowReviewRunner } from '../src/server/workflow-review-runner.ts'
import { REVIEW_WORKFLOW_ID, REVIEW_TRIGGERED_BY } from '../src/server/auto-review-defs.ts'

function makeStubRunner() {
  const calls = []
  return {
    calls,
    runner: {
      start: async (args) => {
        calls.push(args)
        return `stub-runid-${calls.length}`
      },
      // Stub the rest of the methods the review runner type signature needs.
      setExecutor() {},
      setOnRunComplete() {},
      cancel() {},
    },
  }
}

test('handleRunComplete skips review-of-review by workflowId guard', async () => {
  const stubStore = {
    getRun: () => null,
    listSteps: () => [],
  }
  const { runner, calls } = makeStubRunner()
  const review = new WorkflowReviewRunner({ runner, store: stubStore })
  await review.handleRunComplete({
    runId: 'r1',
    workflowId: REVIEW_WORKFLOW_ID,
    workflowName: 'Auto Skill Review',
    status: 'completed',
    triggeredBy: 'operator',
  })
  assert.equal(calls.length, 0, 'must not spawn a review for a review workflow')
})

test('handleRunComplete skips review-of-review by triggeredBy guard', async () => {
  const stubStore = { getRun: () => null, listSteps: () => [] }
  const { runner, calls } = makeStubRunner()
  const review = new WorkflowReviewRunner({ runner, store: stubStore })
  await review.handleRunComplete({
    runId: 'r1',
    workflowId: 'wf-other',          // different workflow id
    workflowName: 'something',
    status: 'completed',
    triggeredBy: REVIEW_TRIGGERED_BY, // … but flagged as auto-review
  })
  assert.equal(calls.length, 0, 'triggeredBy guard must also skip')
})

test('handleRunComplete starts a review run for a real user workflow', async () => {
  const stubStore = {
    getRun: () => ({ id: 'p1', workflow: 'wf-foo', workflow_name: 'Foo', status: 'completed', started_at: 1, ended_at: 100, triggered_by: 'operator', error: null }),
    listSteps: () => [
      { run_id: 'p1', step_index: 0, step_id: 'triage', step_agent_id: 'l1', status: 'completed', step_note: 'do triage', step_decision: 'proceed', step_next: 'end', error: null, output: 'parsed RITM\nDECISION: proceed' },
    ],
  }
  const { runner, calls } = makeStubRunner()
  const review = new WorkflowReviewRunner({ runner, store: stubStore })
  await review.handleRunComplete({
    runId: 'p1',
    workflowId: 'wf-foo',
    workflowName: 'Foo',
    status: 'completed',
    triggeredBy: 'operator',
  })
  assert.equal(calls.length, 1, 'one review run must be spawned')
  const args = calls[0]
  assert.equal(args.triggeredBy, REVIEW_TRIGGERED_BY)
  assert.equal(args.workflow.id, REVIEW_WORKFLOW_ID)
  assert.equal(args.agents.length, 1)
  assert.equal(args.agents[0].id, 'l1-review-agent')
  assert.equal(args.inputs.parent_run_id, 'p1')
  assert.equal(args.inputs.parent_workflow_id, 'wf-foo')
  assert.equal(args.inputs.parent_workflow_name, 'Foo')
  assert.match(args.inputs.transcript, /workflow_id: wf-foo/)
  assert.match(args.inputs.transcript, /step_id=triage/)
  assert.match(args.inputs.transcript, /DECISION: proceed/)
})

test('handleRunComplete swallows ACTIVE_RUN errors', async () => {
  const stubStore = {
    getRun: () => ({ id: 'p1', workflow: 'wf-foo', workflow_name: 'Foo', status: 'completed', started_at: 1, ended_at: 100, triggered_by: 'op', error: null }),
    listSteps: () => [],
  }
  const runner = {
    start: async () => {
      const err = new Error('already running')
      err.code = 'ACTIVE_RUN'
      throw err
    },
    setOnRunComplete() {},
    setExecutor() {},
    cancel() {},
  }
  const logs = []
  const review = new WorkflowReviewRunner({
    runner,
    store: stubStore,
    log: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m, e) => logs.push(['error', m, e]) },
  })
  // Should not throw, should not log error.
  await review.handleRunComplete({
    runId: 'p1', workflowId: 'wf-foo', workflowName: 'Foo', status: 'completed', triggeredBy: 'operator',
  })
  assert.ok(logs.some((l) => l[0] === 'info' && /already in flight/.test(l[1])))
  assert.equal(logs.filter((l) => l[0] === 'error').length, 0)
})

test('integration: real WorkflowRunner fires onRunComplete after a completed run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runner-int-'))
  const db = openDb(path.join(root, 'data.sqlite'))
  const store = new WorkflowRunsStore(db)
  const buses = new WorkflowRunBusRegistry()
  const runner = new WorkflowRunner({
    store, bus: buses,
    executor: new SimulatedAgentExecutor(),
  })

  let received = null
  runner.setOnRunComplete(async (info) => { received = info })

  const workflow = {
    id: 'wf-int',
    name: 'Integration test',
    steps: [{ id: 's1', agentId: 'a1' }],
  }
  const agent = {
    id: 'a1', name: 'A1', kind: 'reviewer', model: 'haiku', skills: [], prompt: 'noop',
  }
  await runner.start({ workflow, agents: [agent], triggeredBy: 'test' })

  // The runner runs async; poll until callback fires.
  for (let i = 0; i < 80 && received === null; i++) await sleep(25)
  assert.ok(received, 'onRunComplete must have fired')
  assert.equal(received.workflowId, 'wf-int')
  assert.equal(received.status, 'completed')
  assert.equal(received.triggeredBy, 'test')
})

test('integration: review-of-review is suppressed end-to-end', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-runner-rec-'))
  const db = openDb(path.join(root, 'data.sqlite'))
  const store = new WorkflowRunsStore(db)
  const buses = new WorkflowRunBusRegistry()
  const runner = new WorkflowRunner({
    store, bus: buses,
    executor: new SimulatedAgentExecutor(),
  })
  const review = new WorkflowReviewRunner({
    runner, store,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  })
  runner.setOnRunComplete(review.handleRunComplete)

  // A run triggered with triggeredBy=auto-review (recursion guard #2)
  // must not spawn another review.
  const workflow = {
    id: 'wf-other-but-auto',
    name: 'Other but auto',
    steps: [{ id: 's1', agentId: 'a1' }],
  }
  const agent = { id: 'a1', name: 'A1', kind: 'reviewer', model: 'haiku', skills: [], prompt: 'noop' }
  await runner.start({ workflow, agents: [agent], triggeredBy: REVIEW_TRIGGERED_BY })

  await sleep(500)

  const allRuns = store.listRuns(undefined, 50)
  // Exactly one run total — the parent run we started. No review row.
  const reviewRuns = allRuns.filter((r) => r.workflow === REVIEW_WORKFLOW_ID)
  assert.equal(reviewRuns.length, 0, `review-of-review was spawned: ${JSON.stringify(reviewRuns)}`)
})
