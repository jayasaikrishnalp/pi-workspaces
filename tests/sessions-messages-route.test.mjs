/**
 * GET /api/sessions/:sessionKey/messages — history hydration endpoint.
 *
 * Spec:
 *   - 200 with { messages: ChatMessage[] }
 *   - 404 when sessionKey is unknown
 *   - Empty array when no runs landed yet
 *   - Per run, in chronological order:
 *       1. a 'user' ChatMessage with text = run meta.prompt
 *       2. one 'assistant' ChatMessage per assistant chat_messages row
 *          with text = content, optional usage tokens
 *       3. tool rows are folded into the preceding assistant message's
 *          toolCalls array (so the UI groups them)
 *   - Multi-run sessions are sorted by run.startedAt ascending
 *
 * No streaming events; the frontend dispatches a single `hydrate` action
 * with these final messages.
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

async function bootHttp() {
  _resetWiringForTests()
  // Bypass auth — the existing sessions-route tests do the same via env.
  process.env.PI_WORKSPACE_AUTH_DISABLED = '1'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessmsgs-'))
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
    port, server, bus, runStore, tracker, sessions, db, root,
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

/**
 * Seed a run on disk by writing meta.json directly. RunStore.startRun stamps
 * its own Date.now() over startedAt, which we need to control in tests.
 */
async function seedRun(ctx, { runId, sessionKey, prompt, startedAt, finishedAt = startedAt + 1000 }) {
  const dir = path.join(ctx.runStore.root, runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    runId, sessionKey, prompt, status: 'success', startedAt, finishedAt,
  }, null, 2))
}

/** Insert a finalized assistant row directly (mirrors what chat-persister does). */
function seedAssistantRow(ctx, { id, runId, sessionKey, content, createdAt, tokensIn = 0, tokensOut = 0 }) {
  ctx.db.prepare(`
    INSERT INTO chat_messages (id, run_id, session_id, role, content,
      tokens_in, tokens_out, cache_read, cache_write, cost_usd, created_at)
    VALUES (?, ?, ?, 'assistant', ?, ?, ?, 0, 0, 0, ?)
  `).run(id, runId, sessionKey, content, tokensIn, tokensOut, createdAt)
}

function seedToolRow(ctx, { id, runId, sessionKey, toolName, toolCalls, createdAt }) {
  ctx.db.prepare(`
    INSERT INTO chat_messages (id, run_id, session_id, role, content,
      tool_name, tool_calls, created_at)
    VALUES (?, ?, ?, 'tool', NULL, ?, ?, ?)
  `).run(id, runId, sessionKey, toolName, JSON.stringify(toolCalls), createdAt)
}

test('GET /api/sessions/:key/messages → 404 for unknown session', async () => {
  const ctx = await bootHttp()
  try {
    const r = await fetchJson(ctx.port, '/api/sessions/sess_does_not_exist/messages')
    assert.equal(r.status, 404)
    assert.equal(r.body.error?.code, 'UNKNOWN_SESSION')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/sessions/:key/messages → empty array for known session with no runs', async () => {
  const ctx = await bootHttp()
  try {
    const c = await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })
    const sessionKey = c.body.sessionKey
    const r = await fetchJson(ctx.port, `/api/sessions/${sessionKey}/messages`)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { messages: [] })
  } finally {
    await ctx.stop()
  }
})

test('GET /api/sessions/:key/messages → user prompt + assistant message in order', async () => {
  const ctx = await bootHttp()
  try {
    const c = await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })
    const sessionKey = c.body.sessionKey

    await seedRun(ctx, {
      runId: 'r1', sessionKey, prompt: 'hello',
      startedAt: 1_000_000,
    })
    seedAssistantRow(ctx, {
      id: 'a1', runId: 'r1', sessionKey,
      content: 'hi there',
      createdAt: 1_000_500,
      tokensIn: 5, tokensOut: 3,
    })

    const r = await fetchJson(ctx.port, `/api/sessions/${sessionKey}/messages`)
    assert.equal(r.status, 200)
    assert.equal(r.body.messages.length, 2)

    const [u, a] = r.body.messages
    assert.equal(u.role, 'user')
    assert.equal(u.text, 'hello')

    assert.equal(a.role, 'assistant')
    assert.equal(a.id, 'a1')
    assert.equal(a.text, 'hi there')
    assert.equal(a.streaming, false)
    assert.deepEqual(a.toolCalls, [])
  } finally {
    await ctx.stop()
  }
})

test('GET /api/sessions/:key/messages → tool rows fold into preceding assistant.toolCalls', async () => {
  const ctx = await bootHttp()
  try {
    const c = await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })
    const sessionKey = c.body.sessionKey

    await seedRun(ctx, { runId: 'r1', sessionKey, prompt: 'list files', startedAt: 1_000_000 })
    // Order matters: assistant emits toolCall, tool runs, then assistant finalizes.
    seedToolRow(ctx, {
      id: 't1', runId: 'r1', sessionKey,
      toolName: 'bash',
      toolCalls: { id: 'tc1', name: 'bash', args: { command: 'ls' }, result: 'a.txt\nb.txt', status: 'completed' },
      createdAt: 1_000_300,
    })
    seedAssistantRow(ctx, {
      id: 'a1', runId: 'r1', sessionKey,
      content: 'I found two files.', createdAt: 1_000_600,
    })

    const r = await fetchJson(ctx.port, `/api/sessions/${sessionKey}/messages`)
    assert.equal(r.status, 200)
    // Expected: [user, assistant(with toolCalls=[tc1])]
    assert.equal(r.body.messages.length, 2)
    const a = r.body.messages[1]
    assert.equal(a.role, 'assistant')
    assert.equal(a.toolCalls.length, 1)
    assert.equal(a.toolCalls[0].name, 'bash')
    assert.equal(a.toolCalls[0].status, 'completed')
    assert.equal(a.toolCalls[0].result, 'a.txt\nb.txt')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/sessions/:key/messages → multiple runs sort by startedAt', async () => {
  const ctx = await bootHttp()
  try {
    const c = await fetchJson(ctx.port, '/api/sessions', { method: 'POST' })
    const sessionKey = c.body.sessionKey

    // Insert OUT of order on purpose.
    await seedRun(ctx, { runId: 'r2', sessionKey, prompt: 'second', startedAt: 2_000_000 })
    seedAssistantRow(ctx, { id: 'a2', runId: 'r2', sessionKey, content: 'reply 2', createdAt: 2_000_500 })
    await seedRun(ctx, { runId: 'r1', sessionKey, prompt: 'first', startedAt: 1_000_000 })
    seedAssistantRow(ctx, { id: 'a1', runId: 'r1', sessionKey, content: 'reply 1', createdAt: 1_000_500 })

    const r = await fetchJson(ctx.port, `/api/sessions/${sessionKey}/messages`)
    assert.equal(r.status, 200)
    const texts = r.body.messages.map((m) => m.text)
    assert.deepEqual(texts, ['first', 'reply 1', 'second', 'reply 2'])
  } finally {
    await ctx.stop()
  }
})
