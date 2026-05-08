/**
 * PATCH /api/skills/:name end-to-end. Boots an HTTP server in-process,
 * creates a skill via POST, then exercises the new PATCH semantics:
 * exact-match success, fuzzy-match success, no-match 404, ambiguous 409,
 * BODY_TOO_LARGE 400.
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

async function boot() {
  _resetWiringForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-patch-'))
  const skillsDir = path.join(root, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  globalThis.__wiring = {
    bus: new ChatEventBus(),
    runStore: new RunStore({ root: path.join(root, 'runs') }),
    tracker: new SendRunTracker(),
    bridge: { send: async () => {}, waitForActiveCompletion: async () => {}, abort: async () => {}, shutdown: async () => {} },
    sessions: new Map(),
    kbBus: new KbEventBus(),
    kbRoot: root,
    skillsDir,
    agentsDir: path.join(root, 'agents'),
    workflowsDir: path.join(root, 'workflows'),
    memoryDir: path.join(root, 'memory'),
    watcher: null,
    confluence: null, confluenceConfigured: false,
    spawnPi: () => { throw new Error('test wiring: spawnPi not stubbed') },
  }
  const net = await import('node:net')
  const port = await new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
  const server = startServer(port, globalThis.__wiring)
  await once(server, 'listening')
  return {
    port,
    skillsDir,
    async stop() {
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

async function createSkill(ctx, name, body) {
  const r = await jsonFetch(ctx.port, '/api/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content: body, frontmatter: { description: 'test' } }),
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
}

test('PATCH /api/skills/:name applies an exact-match replacement', async () => {
  const ctx = await boot()
  try {
    await createSkill(ctx, 'patch-exact', '# foo\n\nThe answer is 42.\n')
    const r = await jsonFetch(ctx.port, '/api/skills/patch-exact', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_string: 'is 42', new_string: 'is 100' }),
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.replacements, 1)
    assert.equal(r.body.strategy, 'exact')
    const file = fs.readFileSync(path.join(ctx.skillsDir, 'patch-exact', 'SKILL.md'), 'utf8')
    assert.match(file, /The answer is 100\./)
  } finally { await ctx.stop() }
})

test('PATCH /api/skills/:name falls through to fuzzy strategies', async () => {
  const ctx = await boot()
  try {
    await createSkill(ctx, 'patch-fuzz', '# foo\n\n  some line  \n  next line  \n')
    // Whitespace drift: agent supplies lines without surrounding spaces.
    const r = await jsonFetch(ctx.port, '/api/skills/patch-fuzz', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_string: 'some line\nnext line', new_string: 'A\nB' }),
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.replacements, 1)
    assert.notEqual(r.body.strategy, 'exact')
    const file = fs.readFileSync(path.join(ctx.skillsDir, 'patch-fuzz', 'SKILL.md'), 'utf8')
    assert.match(file, /\nA\nB\n/)
  } finally { await ctx.stop() }
})

test('PATCH /api/skills/:name returns 404 PATCH_NO_MATCH when nothing matches', async () => {
  const ctx = await boot()
  try {
    await createSkill(ctx, 'patch-miss', '# foo\n')
    const r = await jsonFetch(ctx.port, '/api/skills/patch-miss', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_string: 'this string does not appear', new_string: 'X' }),
    })
    assert.equal(r.status, 404)
    assert.equal(r.body.error.code, 'PATCH_NO_MATCH')
  } finally { await ctx.stop() }
})

test('PATCH /api/skills/:name returns 409 PATCH_AMBIGUOUS on multiple matches', async () => {
  const ctx = await boot()
  try {
    await createSkill(ctx, 'patch-amb', '# foo\n\nfoo\nfoo\nfoo\n')
    const r = await jsonFetch(ctx.port, '/api/skills/patch-amb', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_string: 'foo', new_string: 'BAR' }),
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.error.code, 'PATCH_AMBIGUOUS')
  } finally { await ctx.stop() }
})

test('PATCH /api/skills/:name with replace_all=true succeeds on multiple matches', async () => {
  const ctx = await boot()
  try {
    await createSkill(ctx, 'patch-all', '# foo\n\nfoo\nfoo\nfoo\n')
    const r = await jsonFetch(ctx.port, '/api/skills/patch-all', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_string: 'foo', new_string: 'BAR', replace_all: true }),
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    // The first 'foo' is in '# foo' (heading) — exact match counts it too.
    assert.ok(r.body.replacements >= 3)
  } finally { await ctx.stop() }
})

test('PATCH rejects ../ path traversal in file_path', async () => {
  const ctx = await boot()
  try {
    await createSkill(ctx, 'patch-trav', '# foo\n')
    const r = await jsonFetch(ctx.port, '/api/skills/patch-trav', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_string: 'foo', new_string: 'X', file_path: '../../etc/passwd' }),
    })
    assert.equal(r.status, 400)
  } finally { await ctx.stop() }
})
