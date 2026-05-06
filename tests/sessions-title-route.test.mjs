/**
 * Sessions title API:
 *   - GET /api/sessions returns each session with optional `title`
 *   - PUT /api/sessions/:key/title { title } sets a manual title (200)
 *   - PUT empty title clears it
 *   - PUT trims whitespace and rejects > 200 chars (400)
 *   - PUT 404 for unknown session
 *   - Auto-title: send-stream'ing a first prompt persists session_titles
 *     unless one was already set manually
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
import { openDb } from '../src/server/db.ts'
import { setSessionTitle, getSessionTitle, autoTitleIfMissing } from '../src/server/session-titles.ts'

async function bootHttp() {
  _resetWiringForTests()
  process.env.PI_WORKSPACE_AUTH_DISABLED = '1'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sesstitle-'))
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
  const db = openDb(path.join(root, 'data.sqlite'))
  globalThis.__wiring = { bus, runStore, tracker, bridge, sessions, db }
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
    port, server, db, sessions,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()))
      try { db.close() } catch {}
      _resetWiringForTests()
    },
  }
}

async function fetchJson(port, p, init = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, init)
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body }
}

async function jsonReq(port, p, method, body) {
  return fetchJson(port, p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ─────────── Pure session-titles module ───────────

test('session-titles: setSessionTitle round-trips through getSessionTitle', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pure-'))
  const db = openDb(path.join(tmp, 'd.sqlite'))
  try {
    setSessionTitle(db, 'sess_1', 'Hello world')
    assert.equal(getSessionTitle(db, 'sess_1'), 'Hello world')
  } finally { db.close() }
})

test('session-titles: empty title clears the row', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-clear-'))
  const db = openDb(path.join(tmp, 'd.sqlite'))
  try {
    setSessionTitle(db, 'sess_1', 'temp')
    setSessionTitle(db, 'sess_1', '')
    assert.equal(getSessionTitle(db, 'sess_1'), undefined)
  } finally { db.close() }
})

test('session-titles: autoTitleIfMissing seeds from prompt only when nothing exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-auto-'))
  const db = openDb(path.join(tmp, 'd.sqlite'))
  try {
    autoTitleIfMissing(db, 'sess_1', 'Investigate the most recent CloudWatch alarm right now please')
    const t1 = getSessionTitle(db, 'sess_1')
    // Truncated to <= 60 chars, single line.
    assert.ok(t1 && t1.length <= 60)
    assert.ok(!t1.includes('\n'))

    // Manual title wins — autoTitleIfMissing won't override.
    setSessionTitle(db, 'sess_1', 'My custom title')
    autoTitleIfMissing(db, 'sess_1', 'Different prompt that should be ignored')
    assert.equal(getSessionTitle(db, 'sess_1'), 'My custom title')
  } finally { db.close() }
})

// ─────────── HTTP API ───────────

test('GET /api/sessions returns each session with optional title field', async () => {
  const ctx = await bootHttp()
  try {
    const c1 = await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })
    const k1 = c1.body.sessionKey
    const c2 = await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })
    const k2 = c2.body.sessionKey
    setSessionTitle(ctx.db, k2, 'Named session')

    const list = await fetchJson(ctx.port, '/api/sessions')
    assert.equal(list.status, 200)
    const a = list.body.sessions.find((s) => s.sessionKey === k1)
    const b = list.body.sessions.find((s) => s.sessionKey === k2)
    // Untitled session — title undefined or absent (don't dictate which).
    assert.ok(!a.title)
    assert.equal(b.title, 'Named session')
  } finally { await ctx.stop() }
})

test('PUT /api/sessions/:key/title sets and clears the title', async () => {
  const ctx = await bootHttp()
  try {
    const c = await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })
    const k = c.body.sessionKey

    const r1 = await jsonReq(ctx.port, `/api/sessions/${k}/title`, 'PUT', { title: '  Trimmed Title  ' })
    assert.equal(r1.status, 200)
    assert.equal(r1.body.title, 'Trimmed Title')

    const list1 = await fetchJson(ctx.port, '/api/sessions')
    assert.equal(list1.body.sessions.find((s) => s.sessionKey === k).title, 'Trimmed Title')

    const r2 = await jsonReq(ctx.port, `/api/sessions/${k}/title`, 'PUT', { title: '' })
    assert.equal(r2.status, 200)
    assert.equal(r2.body.title, null)

    const list2 = await fetchJson(ctx.port, '/api/sessions')
    assert.ok(!list2.body.sessions.find((s) => s.sessionKey === k).title)
  } finally { await ctx.stop() }
})

test('PUT title rejects > 200 chars', async () => {
  const ctx = await bootHttp()
  try {
    const c = await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })
    const k = c.body.sessionKey
    const r = await jsonReq(ctx.port, `/api/sessions/${k}/title`, 'PUT', { title: 'x'.repeat(201) })
    assert.equal(r.status, 400)
    assert.equal(r.body.error?.code, 'BAD_REQUEST')
  } finally { await ctx.stop() }
})

test('PUT title 404 for unknown session', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jsonReq(ctx.port, '/api/sessions/sess_unknown/title', 'PUT', { title: 'no' })
    assert.equal(r.status, 404)
    assert.equal(r.body.error?.code, 'UNKNOWN_SESSION')
  } finally { await ctx.stop() }
})
