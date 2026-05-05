/**
 * Unit-ish tests for /api/runs/:runId/events that don't need real pi.
 * We boot the workspace's HTTP server but inject the wiring so the bridge is
 * a fake we drive event-by-event.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { _resetWiringForTests, getWiring } from '../src/server/wiring.ts'
import { startServer } from '../src/server.ts'
import { RunStore } from '../src/server/run-store.ts'
import { ChatEventBus } from '../src/server/chat-event-bus.ts'
import { SendRunTracker } from '../src/server/send-run-tracker.ts'

function makeFakeBridge() {
  const calls = { abort: [] }
  return {
    send: async () => {},
    waitForActiveCompletion: async () => {},
    abort: async (runId) => {
      calls.abort.push(runId)
    },
    shutdown: async () => {},
    _calls: calls,
  }
}

async function bootHttp() {
  _resetWiringForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-route-'))
  const bus = new ChatEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
  const bridge = makeFakeBridge()
  const sessions = new Map()
  // Inject directly via global to bypass getWiring's lazy creation.
  globalThis.__wiring = { bus, runStore, tracker, bridge, sessions }
  // Find a free port
  const net = await import('node:net')
  const port = await new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
  const server = startServer(port, globalThis.__wiring)
  await once(server, 'listening')
  return {
    port,
    server,
    bus,
    runStore,
    sessions,
    root,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()))
      _resetWiringForTests()
    },
  }
}

async function collectSse(port, urlPath, headers = {}) {
  const url = `http://127.0.0.1:${port}${urlPath}`
  const ac = new AbortController()
  const events = []
  let ended = false
  let status = null
  setTimeout(() => ac.abort(), 5_000)
  try {
    const res = await fetch(url, { signal: ac.signal, headers })
    status = res.status
    if (res.status !== 200) return { status, events: [], ended: false, body: await res.text() }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        ended = true
        break
      }
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const evt = parseBlock(block)
        if (evt) events.push(evt)
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError') throw err
  }
  return { status, events, ended }
}

function parseBlock(block) {
  const lines = block.split('\n').filter((l) => l.length > 0)
  let id, event, dataLines = []
  let nonComment = false
  for (const line of lines) {
    if (line.startsWith(':')) continue
    nonComment = true
    if (line.startsWith('id: ')) id = line.slice(4)
    else if (line.startsWith('event: ')) event = line.slice(7)
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
  }
  if (!nonComment) return null
  let data = null
  if (dataLines.length > 0) {
    const raw = dataLines.join('\n')
    try {
      data = JSON.parse(raw)
    } catch {
      data = raw
    }
  }
  return { id, event, data }
}

async function appendOne(runStore, bus, runId, event, data = {}) {
  const enriched = await runStore.appendNormalized(runId, 's1', { event, data })
  bus.emit(enriched)
  return enriched
}

test('replay-aware channel: queueing-during-drain race produces no duplicates and no gaps', async () => {
  const ctx = await bootHttp()
  try {
    await ctx.runStore.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'hi' })
    // Pre-populate 5 events on disk before SSE opens.
    for (let i = 0; i < 5; i++) {
      await appendOne(ctx.runStore, ctx.bus, 'r1', 'tick', { i })
    }
    // Open SSE; while it's draining, push more events through the bus.
    const collectPromise = collectSse(ctx.port, '/api/runs/r1/events?afterSeq=0')
    // Drive 5 more events very rapidly so some land during drain.
    for (let i = 5; i < 10; i++) {
      await appendOne(ctx.runStore, ctx.bus, 'r1', 'tick', { i })
    }
    // Terminal event so the stream closes.
    await appendOne(ctx.runStore, ctx.bus, 'r1', 'run.completed', { runId: 'r1', status: 'success' })
    await ctx.runStore.casStatus('r1', ['running'], 'success', { finishedAt: Date.now() })

    const { events } = await collectPromise
    const seqs = events.map((e) => e.data?.meta?.seq).filter((s) => typeof s === 'number')
    assert.deepStrictEqual(seqs, Array.from({ length: 11 }, (_, i) => i + 1), 'no duplicates, no gaps')
  } finally {
    await ctx.stop()
  }
})

test('replay-aware channel: afterSeq via Last-Event-ID header skips earlier events', async () => {
  const ctx = await bootHttp()
  try {
    await ctx.runStore.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'hi' })
    for (let i = 0; i < 5; i++) {
      await appendOne(ctx.runStore, ctx.bus, 'r1', 'tick', { i })
    }
    await appendOne(ctx.runStore, ctx.bus, 'r1', 'run.completed', { runId: 'r1', status: 'success' })
    await ctx.runStore.casStatus('r1', ['running'], 'success', { finishedAt: Date.now() })

    // No afterSeq param; Last-Event-ID provides resume point.
    const { events } = await collectSse(ctx.port, '/api/runs/r1/events', {
      'Last-Event-ID': 'r1:3',
    })
    const seqs = events.map((e) => e.data.meta.seq)
    assert.deepStrictEqual(seqs, [4, 5, 6])
  } finally {
    await ctx.stop()
  }
})

test('replay-aware channel: Last-Event-ID with mismatched runId returns 400', async () => {
  const ctx = await bootHttp()
  try {
    await ctx.runStore.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'hi' })
    const r = await collectSse(ctx.port, '/api/runs/r1/events', {
      'Last-Event-ID': 'r2:3',
    })
    assert.equal(r.status, 400)
  } finally {
    await ctx.stop()
  }
})

for (const bad of ['abc', '-1', 'NaN', '1.5', '1e3']) {
  test(`replay-aware channel: malformed afterSeq=${bad} returns 400 without SSE handshake`, async () => {
    const ctx = await bootHttp()
    try {
      await ctx.runStore.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'hi' })
      const res = await fetch(`http://127.0.0.1:${ctx.port}/api/runs/r1/events?afterSeq=${encodeURIComponent(bad)}`)
      assert.equal(res.status, 400, `afterSeq=${bad} should be 400 not ${res.status}`)
      const body = await res.json()
      assert.equal(body.error.code, 'BAD_REQUEST')
    } finally {
      await ctx.stop()
    }
  })
}

test('replay-aware channel: unknown runId returns 404', async () => {
  const ctx = await bootHttp()
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/runs/no-such-run/events`)
    assert.equal(res.status, 404)
  } finally {
    await ctx.stop()
  }
})

// ---- abort route ------------------------------------------------------------

test('POST /api/runs/:runId/abort: unknown run returns 404', async () => {
  const ctx = await bootHttp()
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/runs/bogus/abort`, { method: 'POST' })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.equal(body.error.code, 'UNKNOWN_RUN')
  } finally {
    await ctx.stop()
  }
})

test('POST /api/runs/:runId/abort: already-finished run returns 200 alreadyFinished', async () => {
  const ctx = await bootHttp()
  try {
    await ctx.runStore.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'hi' })
    await ctx.runStore.casStatus('r1', ['running'], 'success', { finishedAt: Date.now() })
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/runs/r1/abort`, { method: 'POST' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.alreadyFinished, true)
    assert.equal(body.status, 'success')
  } finally {
    await ctx.stop()
  }
})

test('POST /api/runs/:runId/abort: running run flips to cancelling, emits run.cancelling, calls bridge.abort', async () => {
  const ctx = await bootHttp()
  try {
    await ctx.runStore.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'long' })
    const seen = []
    ctx.bus.subscribe((e) => seen.push(e.event))

    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/runs/r1/abort`, { method: 'POST' })
    assert.equal(res.status, 202)
    const body = await res.json()
    assert.equal(body.cancelled, true)

    // status flipped
    assert.equal(await ctx.runStore.getStatus('r1'), 'cancelling')
    // bus saw run.cancelling
    assert.ok(seen.includes('run.cancelling'), `expected run.cancelling, saw ${seen.join(',')}`)
    // fake bridge.abort was called
    const wiring = globalThis.__wiring
    assert.deepStrictEqual(wiring.bridge._calls.abort, ['r1'])
  } finally {
    await ctx.stop()
  }
})

test('POST /api/runs/:runId/abort: idempotent — second call returns 202 (still cancelling)', async () => {
  const ctx = await bootHttp()
  try {
    await ctx.runStore.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'long' })
    // First abort flips to cancelling.
    const r1 = await fetch(`http://127.0.0.1:${ctx.port}/api/runs/r1/abort`, { method: 'POST' })
    assert.equal(r1.status, 202)
    // Second call while still cancelling — also 202 (idempotent honoring of intent).
    const r2 = await fetch(`http://127.0.0.1:${ctx.port}/api/runs/r1/abort`, { method: 'POST' })
    assert.equal(r2.status, 202)
    const body = await r2.json()
    assert.equal(body.cancelled, true)
    // The second call must NOT emit a second run.cancelling event.
    const events = await ctx.runStore.getEvents('r1')
    const cancellingCount = events.filter((e) => e.event === 'run.cancelling').length
    assert.equal(cancellingCount, 1, 'second abort must not duplicate run.cancelling')
  } finally {
    await ctx.stop()
  }
})

test('POST /api/runs/:runId/abort: agent_end racing CAS — second-after-success returns alreadyFinished', async () => {
  const ctx = await bootHttp()
  try {
    await ctx.runStore.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'task' })
    // Simulate "agent_end first wins" by flipping straight to success before any abort.
    await ctx.runStore.casStatus('r1', ['running'], 'success', { finishedAt: Date.now() })
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/runs/r1/abort`, { method: 'POST' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.alreadyFinished, true)
    assert.equal(body.status, 'success')
  } finally {
    await ctx.stop()
  }
})
