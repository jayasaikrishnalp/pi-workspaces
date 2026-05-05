/**
 * Stage 2 integration smoke: POST /api/send-stream with a real pi --mode rpc child
 * and verify the SSE replay channel delivers a valid event sequence.
 *
 * Requires `pi` on PATH and a configured Copilot auth (it is on the dev VM).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { bootWorkspace, createSession, submitPrompt, collectSse, fetchJson } from './_pi-helpers.mjs'

test('POST /api/send-stream then GET /api/runs/:runId/events delivers a valid event stream', { timeout: 90_000 }, async () => {
  const w = await bootWorkspace()
  try {
    const sessionKey = await createSession(w.port)
    const post = await submitPrompt(w.port, sessionKey, 'reply with the single word: ack')
    assert.equal(post.status, 202, `send-stream status ${post.status}: ${JSON.stringify(post.body)}`)
    assert.match(post.body.runId, /^[0-9a-f-]{36}$/)
    const runId = post.body.runId

    // Active-run lookup should now report the runId.
    const active = await fetchJson(w.port, `/api/sessions/${sessionKey}/active-run`)
    assert.equal(active.status, 200)
    assert.equal(active.body.runId, runId)
    assert.equal(active.body.status, 'running')

    // Replay channel: open, collect until run.completed.
    const collected = await collectSse(w.port, `/api/runs/${runId}/events?afterSeq=0`, {
      stopOn: (evt) => evt.event === 'run.completed',
      timeoutMs: 60_000,
    })
    assert.equal(collected.status, 200)
    const events = collected.events
    assert.ok(events.length > 0, 'expected at least one SSE event')

    // First event must be run.start.
    assert.equal(events[0].event, 'run.start', `first event ${events[0]?.event}`)
    // Last event must be run.completed.
    assert.equal(events[events.length - 1].event, 'run.completed')

    // Seq must be 1..N strictly.
    const seqs = events.map((e) => e.data?.meta?.seq).filter((n) => typeof n === 'number')
    assert.equal(seqs.length, events.length, 'every event must carry meta.seq')
    for (let i = 0; i < seqs.length; i++) {
      assert.equal(seqs[i], i + 1, `seq mismatch at index ${i}: got ${seqs[i]}`)
    }
    // EventId of each must equal `${runId}:${seq}`.
    for (const e of events) {
      assert.equal(e.id, `${runId}:${e.data.meta.seq}`)
      assert.equal(e.data.meta.eventId, `${runId}:${e.data.meta.seq}`)
    }

    // Disk state agrees: events.jsonl on disk has same number of lines, status terminal.
    const eventsFile = path.join(w.root, 'runs', runId, 'events.jsonl')
    const lines = fs.readFileSync(eventsFile, 'utf8').split('\n').filter((l) => l)
    assert.equal(lines.length, events.length)
    const meta = JSON.parse(fs.readFileSync(path.join(w.root, 'runs', runId, 'meta.json'), 'utf8'))
    assert.ok(['success', 'error', 'cancelled'].includes(meta.status), `meta.status=${meta.status}`)

    // Active-run slot is cleared after completion.
    const after = await fetchJson(w.port, `/api/sessions/${sessionKey}/active-run`)
    assert.equal(after.body.runId, null)
  } finally {
    await w.kill()
  }
})
