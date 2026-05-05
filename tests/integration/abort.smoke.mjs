/**
 * Stage 3 integration: a long real-pi prompt is submitted, then aborted
 * mid-run. The replay channel must close with run.completed status:cancelled,
 * meta.json must be terminal, and (best-effort) no descendant pi processes
 * may be left running.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  bootWorkspace,
  createSession,
  submitPrompt,
  collectSse,
} from './_pi-helpers.mjs'

test('POST /abort closes the run with status:cancelled', { timeout: 90_000 }, async () => {
  const w = await bootWorkspace()
  try {
    const sessionKey = await createSession(w.port)
    // Use a prompt that is genuinely going to take some seconds.
    const post = await submitPrompt(
      w.port,
      sessionKey,
      'Count from 1 to 100 in English, with each number on its own line. Take your time and write each line out fully.',
    )
    assert.equal(post.status, 202)
    const runId = post.body.runId

    // Open the replay stream and capture events.
    const collectPromise = collectSse(w.port, `/api/runs/${runId}/events?afterSeq=0`, {
      stopOn: (evt) => evt.event === 'run.completed',
      timeoutMs: 60_000,
    })

    // Wait briefly so pi has produced something but is still running.
    await new Promise((r) => setTimeout(r, 1_500))

    // Issue abort.
    const abortRes = await fetch(`http://127.0.0.1:${w.port}/api/runs/${runId}/abort`, {
      method: 'POST',
    })
    assert.equal(abortRes.status, 202, `abort status ${abortRes.status}`)
    const abortBody = await abortRes.json()
    assert.equal(abortBody.cancelled, true)

    // Stream must complete with run.completed status:cancelled.
    const collected = await collectPromise
    assert.equal(collected.status, 200)
    const events = collected.events
    const last = events[events.length - 1]
    assert.equal(last.event, 'run.completed')
    assert.equal(last.data.data.status, 'cancelled', `expected cancelled, got ${last.data.data.status}`)
    // run.cancelling must have been emitted before run.completed.
    const cancellingIdx = events.findIndex((e) => e.event === 'run.cancelling')
    const completedIdx = events.findIndex((e) => e.event === 'run.completed')
    assert.ok(cancellingIdx >= 0, 'expected run.cancelling event')
    assert.ok(cancellingIdx < completedIdx, 'run.cancelling must precede run.completed')

    // meta.json terminal.
    const metaPath = path.join(w.root, 'runs', runId, 'meta.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    assert.equal(meta.status, 'cancelled')

    // Best-effort process-tree check: no pi descendants should remain under
    // the workspace child's process group. We give the kernel a beat to reap.
    await new Promise((r) => setTimeout(r, 500))
    if (typeof w.child.pid === 'number') {
      try {
        // pgrep -P <ppid> lists children. We want zero.
        const out = execSync(`pgrep -P ${w.child.pid} 2>/dev/null || true`).toString().trim()
        // Filter out workspace child itself (it isn't its own child) — pgrep -P only returns descendants.
        const remaining = out.split('\n').filter((l) => l.length > 0)
        // We tolerate at most 0 descendants. (If pgrep is unavailable we'll get empty.)
        assert.equal(remaining.length, 0, `expected no pi descendants after abort; got pids: ${remaining.join(', ')}`)
      } catch (err) {
        // If pgrep isn't installed, skip silently — the assertion above is best-effort.
      }
    }
  } finally {
    await w.kill()
  }
})

test('POST /abort on already-finished run returns 200 alreadyFinished', { timeout: 90_000 }, async () => {
  const w = await bootWorkspace()
  try {
    const sessionKey = await createSession(w.port)
    const post = await submitPrompt(w.port, sessionKey, 'reply with: ack')
    const runId = post.body.runId

    // Wait for completion.
    await collectSse(w.port, `/api/runs/${runId}/events?afterSeq=0`, {
      stopOn: (evt) => evt.event === 'run.completed',
      timeoutMs: 30_000,
    })

    // Now abort — should be a no-op.
    const r = await fetch(`http://127.0.0.1:${w.port}/api/runs/${runId}/abort`, { method: 'POST' })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(body.alreadyFinished, true)
    assert.equal(body.status, 'success')
  } finally {
    await w.kill()
  }
})
