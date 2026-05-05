/**
 * Stage 2 integration smoke: BOTH orderings of SSE-vs-POST must reach the same
 * final state (every event delivered exactly once, monotonic seq, terminal end).
 *
 * Ordering A — POST first, then SSE replay (covered by send-stream.smoke.mjs).
 * Ordering B — SSE first, then POST: the live channel must capture every event
 * from the very first one (no race on subscribe vs first emit).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { bootWorkspace, createSession, submitPrompt, collectSse } from './_pi-helpers.mjs'

test('chat-events live channel opened BEFORE POST captures every event', { timeout: 90_000 }, async () => {
  const w = await bootWorkspace()
  try {
    const sessionKey = await createSession(w.port)

    // Open chat-events FIRST. Start collecting in the background.
    const collectPromise = collectSse(
      w.port,
      `/api/chat-events?sessionKey=${sessionKey}&tabId=t1`,
      {
        stopOn: (evt) => evt.event === 'run.completed',
        timeoutMs: 60_000,
      },
    )
    // Tiny delay to ensure the SSE handshake completed before POST.
    await new Promise((r) => setTimeout(r, 200))

    const post = await submitPrompt(w.port, sessionKey, 'reply with the single word: ack')
    assert.equal(post.status, 202)
    const runId = post.body.runId

    const collected = await collectPromise
    assert.equal(collected.status, 200)
    const events = collected.events
    assert.ok(events.length >= 2, `expected >=2 events, got ${events.length}`)
    assert.equal(events[0].event, 'run.start')
    assert.equal(events[events.length - 1].event, 'run.completed')

    // Every event must belong to our runId.
    for (const e of events) {
      assert.equal(e.data?.meta?.runId, runId)
    }

    // Seqs cover 1..N with no gaps.
    const seqs = events.map((e) => e.data.meta.seq)
    for (let i = 0; i < seqs.length; i++) {
      assert.equal(seqs[i], i + 1, `seq mismatch at index ${i}: ${seqs[i]}`)
    }
  } finally {
    await w.kill()
  }
})

test('replay after completion still works', { timeout: 90_000 }, async () => {
  const w = await bootWorkspace()
  try {
    const sessionKey = await createSession(w.port)
    const post = await submitPrompt(w.port, sessionKey, 'reply with: hello')
    const runId = post.body.runId

    // First, fully drain via the replay channel (this also ensures completion).
    const live = await collectSse(w.port, `/api/runs/${runId}/events?afterSeq=0`, {
      stopOn: (evt) => evt.event === 'run.completed',
      timeoutMs: 60_000,
    })
    assert.equal(live.events[live.events.length - 1].event, 'run.completed')
    const liveSeqs = live.events.map((e) => e.data.meta.seq)

    // Now reopen the same channel after completion. It must replay everything
    // and close cleanly without hanging.
    const replayed = await collectSse(w.port, `/api/runs/${runId}/events?afterSeq=0`, {
      timeoutMs: 30_000,
    })
    assert.equal(replayed.ended, true, 'replay after completion must end naturally')
    const replayedSeqs = replayed.events.map((e) => e.data.meta.seq)
    assert.deepStrictEqual(replayedSeqs, liveSeqs, 'replayed seq sequence must match live capture')

    // afterSeq cuts the prefix.
    const half = Math.floor(liveSeqs.length / 2)
    const tail = await collectSse(w.port, `/api/runs/${runId}/events?afterSeq=${half}`, {
      timeoutMs: 30_000,
    })
    assert.deepStrictEqual(
      tail.events.map((e) => e.data.meta.seq),
      liveSeqs.slice(half),
    )
  } finally {
    await w.kill()
  }
})
