/**
 * Unit tests for the sessions + chat-events routes that don't need real pi.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { _resetWiringForTests } from '../src/server/wiring.ts'
import { startServer } from '../src/server.ts'
import { RunStore } from '../src/server/run-store.ts'
import { ChatEventBus } from '../src/server/chat-event-bus.ts'
import { SendRunTracker } from '../src/server/send-run-tracker.ts'

async function bootHttp() {
  _resetWiringForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-route-'))
  const bus = new ChatEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
  const bridge = {
    send: async () => {},
    waitForActiveCompletion: async () => {},
    abort: async () => {},
    shutdown: async () => {},
  }
  const sessions = new Map()
  globalThis.__wiring = { bus, runStore, tracker, bridge, sessions }
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
    tracker,
    sessions,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()))
      _resetWiringForTests()
    },
  }
}

async function fetchJson(port, p, init = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, init)
  const text = await r.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: r.status, body }
}

test('POST /api/sessions creates a session and GET /api/sessions lists it', async () => {
  const ctx = await bootHttp()
  try {
    const create = await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })
    assert.equal(create.status, 201)
    // Stable session id format `sess_<epochMs>_<rand6>` per add-session-intelligence.
    assert.match(create.body.sessionKey, /^sess_\d+_[a-z0-9]{6}$/)
    const sessionKey = create.body.sessionKey

    const list = await fetchJson(ctx.port, '/api/sessions')
    assert.equal(list.status, 200)
    assert.ok(Array.isArray(list.body.sessions))
    const found = list.body.sessions.find((s) => s.sessionKey === sessionKey)
    assert.ok(found, 'created session not found in list')
    assert.equal(typeof found.createdAt, 'number')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/sessions/:sessionKey/active-run returns null when idle', async () => {
  const ctx = await bootHttp()
  try {
    const create = await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })
    const sessionKey = create.body.sessionKey

    const r = await fetchJson(ctx.port, `/api/sessions/${sessionKey}/active-run`)
    assert.equal(r.status, 200)
    assert.equal(r.body.runId, null)
  } finally {
    await ctx.stop()
  }
})

test('GET /api/sessions/:sessionKey/active-run on unknown session returns 404', async () => {
  const ctx = await bootHttp()
  try {
    const r = await fetchJson(ctx.port, '/api/sessions/no-such-session/active-run')
    assert.equal(r.status, 404)
    assert.equal(r.body.error.code, 'UNKNOWN_SESSION')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/sessions/:sessionKey/active-run reflects an in-flight run', async () => {
  const ctx = await bootHttp()
  try {
    const create = await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })
    const sessionKey = create.body.sessionKey
    // Manually mark a run as active in the tracker + run-store.
    ctx.tracker.start(sessionKey, 'r1')
    await ctx.runStore.startRun({ runId: 'r1', sessionKey, prompt: 'hi' })
    const r = await fetchJson(ctx.port, `/api/sessions/${sessionKey}/active-run`)
    assert.equal(r.status, 200)
    assert.equal(r.body.runId, 'r1')
    assert.equal(r.body.status, 'running')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/chat-events without sessionKey returns 400', async () => {
  const ctx = await bootHttp()
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/chat-events?tabId=t1`)
    assert.equal(r.status, 400)
    const body = await r.json()
    assert.equal(body.error.code, 'BAD_REQUEST')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/chat-events with unknown sessionKey returns 404', async () => {
  const ctx = await bootHttp()
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/chat-events?sessionKey=bogus&tabId=t1`)
    assert.equal(r.status, 404)
    const body = await r.json()
    assert.equal(body.error.code, 'UNKNOWN_SESSION')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/chat-events filters bus events by sessionKey', async () => {
  const ctx = await bootHttp()
  try {
    const a = (await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })).body.sessionKey
    const b = (await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })).body.sessionKey

    const ac = new AbortController()
    let resolveReady
    const ready = new Promise((r) => (resolveReady = r))
    const collectPromise = (async () => {
      const events = []
      try {
        const res = await fetch(
          `http://127.0.0.1:${ctx.port}/api/chat-events?sessionKey=${a}&tabId=t1`,
          { signal: ac.signal },
        )
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let signaled = false
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          // The handler writes the initial comment block in one frame; once
          // we see "\n\n" we know the subscription is registered.
          if (!signaled && buf.includes('\n\n')) {
            signaled = true
            resolveReady()
          }
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const lines = block.split('\n').filter((l) => l)
            let nonComment = false
            let id, ev, dataLines = []
            for (const line of lines) {
              if (line.startsWith(':')) continue
              nonComment = true
              if (line.startsWith('id: ')) id = line.slice(4)
              else if (line.startsWith('event: ')) ev = line.slice(7)
              else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
            }
            if (nonComment) {
              events.push({ id, event: ev, data: JSON.parse(dataLines.join('\n')) })
            }
          }
        }
      } catch (err) {
        if (err?.name !== 'AbortError') throw err
      }
      return events
    })()

    // Wait for the SSE handshake comment to land before emitting events.
    await ready

    // Emit one event for session a, one for b.
    await ctx.runStore.startRun({ runId: 'rA', sessionKey: a, prompt: 'p' })
    await ctx.runStore.startRun({ runId: 'rB', sessionKey: b, prompt: 'p' })
    const ea = await ctx.runStore.appendNormalized('rA', a, { event: 'run.start', data: {} })
    const eb = await ctx.runStore.appendNormalized('rB', b, { event: 'run.start', data: {} })
    ctx.bus.emit(ea)
    ctx.bus.emit(eb)
    await new Promise((r) => setTimeout(r, 100))
    ac.abort()
    const events = await collectPromise

    // Subscriber sees ONLY session a's event.
    assert.equal(events.length, 1, `expected 1 event, got ${events.length}`)
    assert.equal(events[0].data.meta.sessionKey, a)
  } finally {
    await ctx.stop()
  }
})
