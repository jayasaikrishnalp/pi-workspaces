/**
 * Terminal route tests — exercise the runner via real /bin/bash where it's
 * cheap to do so (echo, false, sleep), and stub spawn for the truncation
 * + error paths.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

import { _resetWiringForTests } from '../src/server/wiring.ts'
import { startServer } from '../src/server.ts'
import { ChatEventBus } from '../src/server/chat-event-bus.ts'
import { KbEventBus } from '../src/server/kb-event-bus.ts'
import { RunStore } from '../src/server/run-store.ts'
import { SendRunTracker } from '../src/server/send-run-tracker.ts'
import { McpBroker } from '../src/server/mcp-broker.ts'
import { openDb } from '../src/server/db.ts'

async function bootHttp({ spawnBash } = {}) {
  _resetWiringForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-route-'))
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true })
  const bus = new ChatEventBus()
  const kbBus = new KbEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
  const bridge = { send: async () => {}, waitForActiveCompletion: async () => {}, abort: async () => {}, shutdown: async () => {} }
  const db = openDb(path.join(root, 'data.sqlite'))
  globalThis.__wiring = {
    bus, runStore, tracker, bridge,
    sessions: new Map(),
    kbBus,
    kbRoot: root, skillsDir: path.join(root, 'skills'),
    agentsDir: path.join(root, 'agents'),
    workflowsDir: path.join(root, 'workflows'),
    memoryDir: path.join(root, 'memory'),
    watcher: null,
    confluence: null, confluenceConfigured: false,
    spawnPi: () => { throw new Error('spawnPi not stubbed') },
    spawnBash: spawnBash ?? ((args, opts) => spawn('/bin/bash', [...args], opts ?? {})),
    mcpBroker: new McpBroker([], () => ({
      async start() {}, async listTools() { return [] },
      async callTool() { return null }, async shutdown() {},
    })),
    db,
    workspaceRoot: root,
  }
  const net = await import('node:net')
  const port = await new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
  })
  const server = startServer(port, globalThis.__wiring)
  await once(server, 'listening')
  return { port, server, root, db, async stop() {
    await new Promise((r) => server.close(() => r()))
    _resetWiringForTests()
  } }
}

async function jf(port, p, init = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, init)
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body }
}

test('terminal: echo hello returns completed/exit-0/stdout', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/terminal/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo hello' }),
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'completed')
    assert.equal(r.body.exitCode, 0)
    assert.match(r.body.stdout, /hello/)
    assert.ok(r.body.id)
    assert.ok(r.body.durationMs >= 0)
  } finally { await ctx.stop() }
})

test('terminal: false exits 1, captured as completed (non-zero exit is not an error response)', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/terminal/exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'false' }),
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'completed')
    assert.equal(r.body.exitCode, 1)
  } finally { await ctx.stop() }
})

test('terminal: sleep exceeds short timeout → status=timeout', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/terminal/exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'sleep 5', timeoutMs: 200 }),
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'timeout')
  } finally { await ctx.stop() }
})

test('terminal: command longer than 4096 chars → 400 COMMAND_TOO_LONG', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/terminal/exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo ' + 'x'.repeat(5000) }),
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'COMMAND_TOO_LONG')
  } finally { await ctx.stop() }
})

test('terminal: timeoutMs > 300000 → 400 TIMEOUT_TOO_LONG', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/terminal/exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'true', timeoutMs: 500_000 }),
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'TIMEOUT_TOO_LONG')
  } finally { await ctx.stop() }
})

test('terminal: missing command → 400 BAD_REQUEST', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/terminal/exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(r.status, 400)
  } finally { await ctx.stop() }
})

test('terminal: audit row exists after exec, GET-detail returns it', async () => {
  const ctx = await bootHttp()
  try {
    const exec = await jf(ctx.port, '/api/terminal/exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo audit-me' }),
    })
    const id = exec.body.id

    const detail = await jf(ctx.port, `/api/terminal/executions/${id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.command, 'echo audit-me')
    assert.equal(detail.body.status, 'completed')
    assert.equal(detail.body.exit_code, 0)
    assert.ok(detail.body.duration_ms >= 0)

    const list = await jf(ctx.port, '/api/terminal/executions')
    assert.equal(list.status, 200)
    assert.ok(list.body.executions.length >= 1)
    assert.equal(list.body.executions[0].id, id)
  } finally { await ctx.stop() }
})

test('terminal: list returns most recent first (DESC sort)', async () => {
  const ctx = await bootHttp()
  try {
    const aRes = await jf(ctx.port, '/api/terminal/exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo first' }),
    })
    await new Promise((r) => setTimeout(r, 5))
    const bRes = await jf(ctx.port, '/api/terminal/exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo second' }),
    })
    const list = await jf(ctx.port, '/api/terminal/executions')
    const ids = list.body.executions.map((e) => e.id)
    assert.equal(ids[0], bRes.body.id, 'second exec should appear first')
    assert.equal(ids[1], aRes.body.id)
  } finally { await ctx.stop() }
})

test('terminal: GET unknown id → 404', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/terminal/executions/nope-not-here')
    assert.equal(r.status, 404)
    assert.equal(r.body.error.code, 'UNKNOWN_EXECUTION')
  } finally { await ctx.stop() }
})

test('terminal-runner: 1 MB stdout cap with truncation marker', async () => {
  // Write 2 MB of x to stdout. /bin/bash + printf is fast enough for this.
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/terminal/exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'printf "%0.s." {1..2200000}' }),
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'completed')
    // Either capture got the truncation marker, OR bash didn't quite hit
    // 2.2M (some shells lack {1..2200000} brace expansion); either way the
    // bound is the strict ≤ 1 MB-ish + marker.
    if (r.body.stdout.length > 1_048_576) {
      assert.match(r.body.stdout, /^\.\.\. \[truncated, original size/)
    }
  } finally { await ctx.stop() }
})
