/**
 * HTTP integration tests for souls + jobs + tasks routes (and the search
 * endpoint, lightly).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { _resetWiringForTests } from '../src/server/wiring.ts'
import { startServer } from '../src/server.ts'
import { ChatEventBus } from '../src/server/chat-event-bus.ts'
import { KbEventBus } from '../src/server/kb-event-bus.ts'
import { RunStore } from '../src/server/run-store.ts'
import { SendRunTracker } from '../src/server/send-run-tracker.ts'
import { McpBroker } from '../src/server/mcp-broker.ts'
import { openDb } from '../src/server/db.ts'

async function bootHttp() {
  _resetWiringForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sjt-route-'))
  const skillsDir = path.join(root, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  const bus = new ChatEventBus()
  const kbBus = new KbEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
  const bridge = {
    send: async () => {}, waitForActiveCompletion: async () => {}, abort: async () => {}, shutdown: async () => {},
  }
  const db = openDb(path.join(root, 'data.sqlite'))
  globalThis.__wiring = {
    bus, runStore, tracker, bridge,
    sessions: new Map(),
    kbBus,
    kbRoot: root, skillsDir,
    agentsDir: path.join(root, 'agents'),
    workflowsDir: path.join(root, 'workflows'),
    memoryDir: path.join(root, 'memory'),
    watcher: null,
    confluence: null, confluenceConfigured: false,
    spawnPi: () => { throw new Error('test wiring: spawnPi not stubbed') },
    mcpBroker: new McpBroker([], () => ({
      async start() {}, async listTools() { return [] },
      async callTool() { return null }, async shutdown() {},
    })),
    db,
  }
  const net = await import('node:net')
  const port = await new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
  const server = startServer(port, globalThis.__wiring)
  await once(server, 'listening')
  return {
    port, server, root, db,
    async stop() {
      await new Promise((r) => server.close(() => r()))
      _resetWiringForTests()
    },
  }
}

async function jf(port, p, init = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, init)
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body }
}

/* ============================== SOULS ============================== */

test('souls: POST creates → GET reads → list contains it', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/souls', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'stoic-operator',
        description: 'calm under fire',
        values: ['honesty', 'caution'],
        priorities: ['safety', 'speed'],
        decision_principles: ['verify before destructive ops'],
        tone: 'measured',
        body: '# stoic-operator\n\nThe agent that does not flinch.',
      }),
    })
    assert.equal(r.status, 201)
    const read = await jf(ctx.port, '/api/souls/stoic-operator')
    assert.equal(read.status, 200)
    assert.deepStrictEqual(read.body.frontmatter.values, ['honesty', 'caution'])
    assert.match(read.body.body, /does not flinch/)

    const list = await jf(ctx.port, '/api/souls')
    assert.equal(list.body.souls.length, 1)
    assert.equal(list.body.souls[0].description, 'calm under fire')
  } finally { await ctx.stop() }
})

test('souls: POST same name twice → 409 SOUL_EXISTS', async () => {
  const ctx = await bootHttp()
  try {
    const body = JSON.stringify({ name: 'dup', description: 'x' })
    const a = await jf(ctx.port, '/api/souls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    assert.equal(a.status, 201)
    const b = await jf(ctx.port, '/api/souls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    assert.equal(b.status, 409)
    assert.equal(b.body.error.code, 'SOUL_EXISTS')
  } finally { await ctx.stop() }
})

test('souls: GET unknown → 404', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/souls/nope')
    assert.equal(r.status, 404)
    assert.equal(r.body.error.code, 'UNKNOWN_SOUL')
  } finally { await ctx.stop() }
})

test('souls: PUT updates frontmatter, name is locked', async () => {
  const ctx = await bootHttp()
  try {
    await jf(ctx.port, '/api/souls', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 's1', description: 'old' }),
    })
    const upd = await jf(ctx.port, '/api/souls/s1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'new', tone: 'crisp' }),
    })
    assert.equal(upd.status, 200)
    const read = await jf(ctx.port, '/api/souls/s1')
    assert.equal(read.body.frontmatter.description, 'new')
    assert.equal(read.body.frontmatter.tone, 'crisp')
    assert.equal(read.body.frontmatter.name, 's1')
  } finally { await ctx.stop() }
})

/* ============================== JOBS ============================== */

test('jobs: list empty initially, then JobsStore inserts surface', async () => {
  const ctx = await bootHttp()
  try {
    const list = await jf(ctx.port, '/api/jobs')
    assert.equal(list.status, 200)
    assert.deepStrictEqual(list.body.jobs, [])

    // Drive the store directly, simulating a chat send wiring.
    const { JobsStore } = await import('../src/server/jobs-store.ts')
    const store = new JobsStore(ctx.db)
    const j = store.create({ title: 'first send', source: 'operator', sessionId: 's1', runId: 'r1' })
    assert.equal(j.status, 'queued')

    const list2 = await jf(ctx.port, '/api/jobs')
    assert.equal(list2.body.jobs.length, 1)
    assert.equal(list2.body.jobs[0].id, j.id)
    assert.equal(list2.body.jobs[0].run_id, 'r1')
  } finally { await ctx.stop() }
})

test('jobs: state machine — queued → running → completed', async () => {
  const ctx = await bootHttp()
  try {
    const { JobsStore } = await import('../src/server/jobs-store.ts')
    const store = new JobsStore(ctx.db)
    const j = store.create({ title: 't', source: 'operator', runId: 'r2' })

    let upd = store.transition(j.id, 'running')
    assert.equal(upd.status, 'running')
    assert.ok(upd.started_at)

    upd = store.transition(j.id, 'completed', { summary: 'all good' })
    assert.equal(upd.status, 'completed')
    assert.equal(upd.summary, 'all good')
    assert.ok(upd.completed_at)

    // Illegal transition.
    assert.throws(() => store.transition(j.id, 'running'), (err) => err.code === 'INVALID_TRANSITION')
  } finally { await ctx.stop() }
})

test('jobs: POST cancel transitions to cancelled, re-cancel returns 409', async () => {
  const ctx = await bootHttp()
  try {
    const { JobsStore } = await import('../src/server/jobs-store.ts')
    const store = new JobsStore(ctx.db)
    const j = store.create({ title: 'will cancel', source: 'operator' })

    const r = await jf(ctx.port, `/api/jobs/${j.id}/cancel`, { method: 'POST' })
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'cancelled')

    const r2 = await jf(ctx.port, `/api/jobs/${j.id}/cancel`, { method: 'POST' })
    assert.equal(r2.status, 409)
    assert.equal(r2.body.error.code, 'INVALID_TRANSITION')
  } finally { await ctx.stop() }
})

test('jobs: GET 404 for unknown id', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/jobs/nope')
    assert.equal(r.status, 404)
    assert.equal(r.body.error.code, 'UNKNOWN_JOB')
  } finally { await ctx.stop() }
})

/* ============================== TASKS ============================== */

test('tasks: POST creates a triage task with source=operator by default', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'check disk' }),
    })
    assert.equal(r.status, 201)
    assert.equal(r.body.status, 'triage')
    assert.equal(r.body.source, 'operator')
  } finally { await ctx.stop() }
})

test('tasks: state machine — triage → todo → ready → running → done', async () => {
  const ctx = await bootHttp()
  try {
    const create = await jf(ctx.port, '/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't' }),
    })
    const id = create.body.id
    for (const next of ['todo', 'ready', 'running', 'done']) {
      const r = await jf(ctx.port, `/api/tasks/${id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      assert.equal(r.status, 200, `transition to ${next} should succeed`)
      assert.equal(r.body.status, next)
    }
  } finally { await ctx.stop() }
})

test('tasks: illegal transition done → todo returns 409', async () => {
  const ctx = await bootHttp()
  try {
    const create = await jf(ctx.port, '/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't', status: 'done' }),
    })
    const r = await jf(ctx.port, `/api/tasks/${create.body.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'todo' }),
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'INVALID_TRANSITION')
  } finally { await ctx.stop() }
})

test('tasks: idempotency-key dedup returns the same id', async () => {
  const ctx = await bootHttp()
  try {
    const body = JSON.stringify({ title: 'dup', idempotency_key: 'abc' })
    const a = await jf(ctx.port, '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    const b = await jf(ctx.port, '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    assert.equal(a.body.id, b.body.id)
    const list = await jf(ctx.port, '/api/tasks')
    assert.equal(list.body.tasks.length, 1)
  } finally { await ctx.stop() }
})

test('tasks: list filtered by source', async () => {
  const ctx = await bootHttp()
  try {
    await jf(ctx.port, '/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'op-1' }),
    })
    await jf(ctx.port, '/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'agent-1', source: 'agent' }),
    })
    const ops = await jf(ctx.port, '/api/tasks?source=operator')
    assert.equal(ops.body.tasks.length, 1)
    assert.equal(ops.body.tasks[0].title, 'op-1')

    const agents = await jf(ctx.port, '/api/tasks?source=agent')
    assert.equal(agents.body.tasks.length, 1)
    assert.equal(agents.body.tasks[0].title, 'agent-1')
  } finally { await ctx.stop() }
})

test('tasks: DELETE archives, does not hard-delete', async () => {
  const ctx = await bootHttp()
  try {
    const c = await jf(ctx.port, '/api/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'to archive' }),
    })
    const d = await jf(ctx.port, `/api/tasks/${c.body.id}`, { method: 'DELETE' })
    assert.equal(d.status, 200)
    assert.equal(d.body.status, 'archived')

    const r = await jf(ctx.port, `/api/tasks/${c.body.id}`)
    assert.equal(r.body.status, 'archived')
  } finally { await ctx.stop() }
})

/* ============================== SEARCH ============================== */

test('search: empty query returns 400', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/search?q=')
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'INVALID_QUERY')
  } finally { await ctx.stop() }
})

test('search: kb_fts upsert via direct API surfaces a match', async () => {
  const ctx = await bootHttp()
  try {
    const { upsertKbFts } = await import('../src/server/db.ts')
    upsertKbFts(ctx.db, 'skill', 'aws-cleanup', 'sweep stale snapshots and ENIs')
    const r = await jf(ctx.port, '/api/search?q=snapshot&kind=skill')
    assert.equal(r.status, 200)
    assert.ok(r.body.results.length >= 1)
    const hit = r.body.results.find((x) => x.name === 'aws-cleanup')
    assert.ok(hit, 'expected aws-cleanup hit')
    assert.match(hit.snippet, /snapshot/i)
    assert.equal(hit.path, 'skills/aws-cleanup/SKILL.md')
  } finally { await ctx.stop() }
})

test('search: substring match via trigram', async () => {
  const ctx = await bootHttp()
  try {
    const { upsertKbFts } = await import('../src/server/db.ts')
    upsertKbFts(ctx.db, 'skill', 'disk-cleanup', 'reclaim journald space')
    const r = await jf(ctx.port, '/api/search?q=urnal')
    assert.equal(r.status, 200)
    assert.ok(r.body.results.find((x) => x.name === 'disk-cleanup'))
  } finally { await ctx.stop() }
})

test('search: specials in query do not crash', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/search?q=' + encodeURIComponent('foo(bar)*'))
    assert.equal(r.status, 200)
  } finally { await ctx.stop() }
})
