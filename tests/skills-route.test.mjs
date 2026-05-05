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
import { KbWatcher } from '../src/server/kb-watcher.ts'
import { RunStore } from '../src/server/run-store.ts'
import { SendRunTracker } from '../src/server/send-run-tracker.ts'

async function bootHttp({ withWatcher = false } = {}) {
  _resetWiringForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-route-'))
  const skillsDir = path.join(root, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  const bus = new ChatEventBus()
  const kbBus = new KbEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
  const bridge = {
    send: async () => {}, waitForActiveCompletion: async () => {}, abort: async () => {}, shutdown: async () => {},
  }
  let watcher = null
  if (withWatcher) {
    watcher = new KbWatcher({ skillsDir, bus: kbBus, stabilityThreshold: 100, pollInterval: 25 })
    await watcher.start()
  }
  globalThis.__wiring = {
    bus, runStore, tracker, bridge,
    sessions: new Map(),
    kbBus, skillsDir, watcher,
    confluence: null, confluenceConfigured: false,
  }
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
    port, server, kbBus, skillsDir, watcher,
    async stop() {
      if (watcher) await watcher.stop()
      await new Promise((r) => server.close(() => r()))
      _resetWiringForTests()
    },
  }
}

async function jsonFetch(port, p, init = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, init)
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body }
}

test('POST /api/skills creates a skill and GET /api/kb/skill/:name reads it', async () => {
  const ctx = await bootHttp()
  try {
    const create = await jsonFetch(ctx.port, '/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'runbook-foo', content: '# Foo\n', frontmatter: { description: 'x' } }),
    })
    assert.equal(create.status, 201)
    assert.equal(create.body.name, 'runbook-foo')
    assert.equal(create.body.path, 'runbook-foo/SKILL.md')

    const read = await jsonFetch(ctx.port, '/api/kb/skill/runbook-foo')
    assert.equal(read.status, 200)
    assert.equal(read.body.name, 'runbook-foo')
    assert.equal(read.body.frontmatter.description, 'x')
    assert.equal(read.body.body, '# Foo\n')
    assert.equal(read.body.path, 'runbook-foo/SKILL.md')
  } finally {
    await ctx.stop()
  }
})

test('POST /api/skills 400 INVALID_SKILL_NAME for bad name', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jsonFetch(ctx.port, '/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bad Name!', content: '' }),
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'INVALID_SKILL_NAME')
  } finally {
    await ctx.stop()
  }
})

test('POST /api/skills 409 SKILL_EXISTS when present', async () => {
  const ctx = await bootHttp()
  try {
    fs.mkdirSync(path.join(ctx.skillsDir, 'dup'), { recursive: true })
    fs.writeFileSync(path.join(ctx.skillsDir, 'dup', 'SKILL.md'), '---\nname: dup\n---\n')
    const r = await jsonFetch(ctx.port, '/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dup', content: 'x' }),
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'SKILL_EXISTS')
  } finally {
    await ctx.stop()
  }
})

test('POST /api/skills 400 BODY_TOO_LARGE for >32 KB content', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jsonFetch(ctx.port, '/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'big', content: 'x'.repeat(33_000) }),
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'BODY_TOO_LARGE')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/kb/skill/:name returns 404 for missing', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jsonFetch(ctx.port, '/api/kb/skill/nope')
    assert.equal(r.status, 404)
    assert.equal(r.body.error.code, 'UNKNOWN_SKILL')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/kb/skill/:name returns 400 INVALID_SKILL_NAME for bad name', async () => {
  const ctx = await bootHttp()
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/kb/skill/Bad%20Name`)
    assert.equal(r.status, 400)
    const body = await r.json()
    assert.equal(body.error.code, 'INVALID_SKILL_NAME')
  } finally {
    await ctx.stop()
  }
})

test('end-to-end demo loop: POST /api/skills → kb.changed → graph reflects new skill', async () => {
  const ctx = await bootHttp({ withWatcher: true })
  try {
    // Subscribe to kb events.
    const ac = new AbortController()
    let resolveReady
    const ready = new Promise((r) => (resolveReady = r))
    const events = []
    const collectPromise = (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/api/kb/events`, { signal: ac.signal })
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let signaled = false
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          if (!signaled && buf.includes('\n\n')) { signaled = true; resolveReady() }
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const lines = block.split('\n').filter((l) => l)
            let nonComment = false
            let ev, dataLines = []
            for (const line of lines) {
              if (line.startsWith(':')) continue
              nonComment = true
              if (line.startsWith('event: ')) ev = line.slice(7)
              else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
            }
            if (nonComment) events.push({ event: ev, data: JSON.parse(dataLines.join('\n')) })
          }
        }
      } catch (err) {
        if (err?.name !== 'AbortError') throw err
      }
      return events
    })()
    await ready

    // Pre-write graph: empty (just-created tempdir).
    const before = await jsonFetch(ctx.port, '/api/kb/graph')
    assert.equal(before.body.nodes.length, 0)

    // POST a new skill.
    const create = await jsonFetch(ctx.port, '/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'created-via-api', content: '# Created\n', frontmatter: { description: 'a new skill' } }),
    })
    assert.equal(create.status, 201)

    // Wait up to 1500ms for kb.changed.
    const deadline = Date.now() + 1500
    let saw = false
    while (Date.now() < deadline) {
      saw = events.some((e) => e.event === 'kb.changed' && e.data.kind === 'add' && e.data.skill === 'created-via-api')
      if (saw) break
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.ok(saw, `expected kb.changed for created-via-api within 1500ms; got ${JSON.stringify(events)}`)
    ac.abort()
    await collectPromise

    // After: graph reflects the new skill.
    const after = await jsonFetch(ctx.port, '/api/kb/graph')
    const ids = after.body.nodes.map((n) => n.id)
    assert.deepStrictEqual(ids, ['created-via-api'])
  } finally {
    await ctx.stop()
  }
})
