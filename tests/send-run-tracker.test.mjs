import test from 'node:test'
import assert from 'node:assert/strict'

import { SendRunTracker } from '../src/server/send-run-tracker.ts'

test('start reserves the slot and getActive returns the runId', () => {
  const t = new SendRunTracker()
  t.start('s1', 'r1')
  assert.equal(t.getActive('s1'), 'r1')
})

test('start on a busy slot throws ACTIVE_RUN with the existing runId', () => {
  const t = new SendRunTracker()
  t.start('s1', 'r1')
  try {
    t.start('s1', 'r2')
    assert.fail('expected throw')
  } catch (err) {
    assert.equal(err.code, 'ACTIVE_RUN')
    assert.equal(err.activeRunId, 'r1')
  }
})

test('finish clears the slot and is idempotent', () => {
  const t = new SendRunTracker()
  t.start('s1', 'r1')
  t.finish('s1', 'r1')
  assert.equal(t.getActive('s1'), null)
  // calling finish again is a no-op
  t.finish('s1', 'r1')
})

test('finish only clears when runId matches the active slot', () => {
  const t = new SendRunTracker()
  t.start('s1', 'r1')
  t.finish('s1', 'rXXX') // different runId — should NOT clear
  assert.equal(t.getActive('s1'), 'r1')
})

test('multiple sessions are independent', () => {
  const t = new SendRunTracker()
  t.start('s1', 'r1')
  t.start('s2', 'r2')
  assert.equal(t.getActive('s1'), 'r1')
  assert.equal(t.getActive('s2'), 'r2')
  t.finish('s1', 'r1')
  assert.equal(t.getActive('s1'), null)
  assert.equal(t.getActive('s2'), 'r2')
})

test('finishAll clears every slot and returns the cleared runIds', () => {
  const t = new SendRunTracker()
  t.start('s1', 'r1')
  t.start('s2', 'r2')
  const cleared = t.finishAll()
  assert.deepStrictEqual(cleared.sort(), ['r1', 'r2'])
  assert.equal(t.getActive('s1'), null)
  assert.equal(t.getActive('s2'), null)
})
