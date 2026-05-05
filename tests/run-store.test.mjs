import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { RunStore } from '../src/server/run-store.ts'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-'))
}

test('startRun creates dir + meta.json with status running', async () => {
  const root = tmpRoot()
  const store = new RunStore({ root })
  const meta = await store.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'hi' })
  assert.equal(meta.status, 'running')
  assert.ok(fs.existsSync(path.join(root, 'r1', 'meta.json')))
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'r1', 'meta.json'), 'utf8')).status, 'running')
})

test('appendNormalized assigns monotonic seq + eventId', async () => {
  const root = tmpRoot()
  const store = new RunStore({ root })
  await store.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'hi' })
  const a = await store.appendNormalized('r1', 's1', { event: 'run.start', data: { x: 1 } })
  const b = await store.appendNormalized('r1', 's1', { event: 'turn.start', data: {} })
  const c = await store.appendNormalized('r1', 's1', { event: 'run.completed', data: { status: 'success' } })
  assert.equal(a.meta.seq, 1)
  assert.equal(b.meta.seq, 2)
  assert.equal(c.meta.seq, 3)
  assert.equal(a.meta.eventId, 'r1:1')
  assert.equal(b.meta.eventId, 'r1:2')
  assert.equal(c.meta.eventId, 'r1:3')
})

test('concurrent appendNormalized for same runId is serialized via write chain', async () => {
  const root = tmpRoot()
  const store = new RunStore({ root })
  await store.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'hi' })
  const N = 50
  const promises = Array.from({ length: N }, (_, i) =>
    store.appendNormalized('r1', 's1', { event: 'tick', data: { i } }),
  )
  const results = await Promise.all(promises)
  const seqs = results.map((r) => r.meta.seq).sort((a, b) => a - b)
  assert.deepStrictEqual(seqs, Array.from({ length: N }, (_, i) => i + 1))
  // events.jsonl on disk has the same N lines
  const lines = fs.readFileSync(path.join(root, 'r1', 'events.jsonl'), 'utf8').split('\n').filter((l) => l)
  assert.equal(lines.length, N)
})

test('getEvents filters by afterSeq and returns sorted', async () => {
  const root = tmpRoot()
  const store = new RunStore({ root })
  await store.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'hi' })
  for (let i = 0; i < 5; i++) {
    await store.appendNormalized('r1', 's1', { event: 'tick', data: { i } })
  }
  const all = await store.getEvents('r1')
  assert.equal(all.length, 5)
  assert.deepStrictEqual(all.map((e) => e.meta.seq), [1, 2, 3, 4, 5])
  const after2 = await store.getEvents('r1', { afterSeq: 2 })
  assert.deepStrictEqual(after2.map((e) => e.meta.seq), [3, 4, 5])
})

test('getEvents on missing run returns empty array', async () => {
  const root = tmpRoot()
  const store = new RunStore({ root })
  const events = await store.getEvents('nonexistent')
  assert.deepStrictEqual(events, [])
})

test('casStatus only transitions on expected', async () => {
  const root = tmpRoot()
  const store = new RunStore({ root })
  await store.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'hi' })
  // wrong expected
  const bad = await store.casStatus('r1', 'success', 'cancelled')
  assert.equal(bad, false)
  assert.equal(await store.getStatus('r1'), 'running')
  // correct expected
  const ok = await store.casStatus('r1', 'running', 'success', { finishedAt: 12345 })
  assert.equal(ok, true)
  assert.equal(await store.getStatus('r1'), 'success')
  // second transition is no-op
  const noop = await store.casStatus('r1', 'running', 'cancelled')
  assert.equal(noop, false)
  assert.equal(await store.getStatus('r1'), 'success')
})

test('getStatus on missing run returns null', async () => {
  const root = tmpRoot()
  const store = new RunStore({ root })
  assert.equal(await store.getStatus('nope'), null)
})
