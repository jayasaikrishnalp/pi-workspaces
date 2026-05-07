/**
 * Pure unit tests of `chooseNext(step, decision, steps, index)`.
 * No DB, no pi, no bus — just the routing decision.
 *
 * Spec:
 *   - branches+matching decision → branches[decision]
 *   - branches+missing/unknown decision → falls through to step.next, else default
 *   - explicit step.next → that
 *   - no branches, no next → next list element
 *   - no branches, no next, last step → 'end'
 *   - 'end' value in branches/next is preserved
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { chooseNext } from '../src/server/workflow-runner.ts'

const STEPS = [
  { id: 'a', agentId: 'A' },
  { id: 'b', agentId: 'B', branches: { ok: 'c', deny: 'end' } },
  { id: 'c', agentId: 'C', next: 'a' },
  { id: 'd', agentId: 'D' },
]

test('chooseNext: branches with matching decision routes to branches[decision]', () => {
  assert.equal(chooseNext(STEPS[1], 'ok', STEPS, 1), 'c')
  assert.equal(chooseNext(STEPS[1], 'deny', STEPS, 1), 'end')
})

test('chooseNext: branches with unknown decision falls through to next/list', () => {
  assert.equal(chooseNext(STEPS[1], 'foo', STEPS, 1), 'c') // no .next, defaults to list[i+1]
  assert.equal(chooseNext(STEPS[1], null, STEPS, 1), 'c')
})

test('chooseNext: branches+unknown decision but step.next set → next', () => {
  const step = { id: 'x', agentId: 'X', branches: { ok: 'a' }, next: 'd' }
  const list = [step, ...STEPS]
  assert.equal(chooseNext(step, null, list, 0), 'd')
  assert.equal(chooseNext(step, 'wat', list, 0), 'd')
})

test('chooseNext: no branches, explicit next → that', () => {
  assert.equal(chooseNext(STEPS[2], null, STEPS, 2), 'a')
})

test('chooseNext: no branches, no next, has follower → list[i+1]', () => {
  assert.equal(chooseNext(STEPS[0], null, STEPS, 0), 'b')
})

test("chooseNext: last step with no branches and no next → 'end'", () => {
  assert.equal(chooseNext(STEPS[3], null, STEPS, 3), 'end')
})
