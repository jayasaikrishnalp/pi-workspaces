/**
 * Stage 2 integration: a second POST while a run is in flight must 409 with
 * a structured body. After completion, a new POST must succeed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { bootWorkspace, createSession, submitPrompt, collectSse } from './_pi-helpers.mjs'

test('a second POST during an active run returns 409 ACTIVE_RUN', { timeout: 90_000 }, async () => {
  const w = await bootWorkspace()
  try {
    const sessionKey = await createSession(w.port)
    const first = await submitPrompt(w.port, sessionKey, 'reply with: ack')
    assert.equal(first.status, 202)
    const firstRunId = first.body.runId

    // Immediately attempt a second submission. Must reject with 409.
    const second = await submitPrompt(w.port, sessionKey, 'a different prompt')
    assert.equal(second.status, 409, `expected 409, got ${second.status}: ${JSON.stringify(second.body)}`)
    assert.equal(second.body.error.code, 'ACTIVE_RUN')
    assert.equal(second.body.error.details.activeRunId, firstRunId)

    // Drain the first run.
    await collectSse(w.port, `/api/runs/${firstRunId}/events?afterSeq=0`, {
      stopOn: (evt) => evt.event === 'run.completed',
      timeoutMs: 60_000,
    })

    // Now a second POST should succeed.
    const third = await submitPrompt(w.port, sessionKey, 'second prompt: reply ok')
    assert.equal(third.status, 202)
    assert.notEqual(third.body.runId, firstRunId)
  } finally {
    await w.kill()
  }
})
