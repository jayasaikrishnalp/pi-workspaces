/**
 * Tests for the MCP user-overlay (mcp-servers.json) and the
 * POST/DELETE /api/mcp/servers endpoints.
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
import {
  loadOverlay, saveOverlay, addOverlayServer, removeOverlayServer, validateServerConfig, overlayPath,
} from '../src/server/mcp-overlay.ts'

function stubClient() {
  return {
    async start() {},
    async listTools() { return [] },
    async callTool() { return null },
    async shutdown() {},
  }
}

async function bootHttp({ root, seed = [] } = {}) {
  _resetWiringForTests()
  process.env.PI_WORKSPACE_AUTH_DISABLED = '1'
  if (!root) root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-overlay-'))
  const bus = new ChatEventBus()
  const kbBus = new KbEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
  const bridge = { send: async () => {}, waitForActiveCompletion: async () => {}, abort: async () => {}, shutdown: async () => {} }
  const mcpBroker = new McpBroker(seed, () => stubClient())
  globalThis.__wiring = {
    bus, runStore, tracker, bridge,
    sessions: new Map(), kbBus,
    kbRoot: root, skillsDir: path.join(root, 'skills'),
    agentsDir: path.join(root, 'agents'),
    workflowsDir: path.join(root, 'workflows'),
    memoryDir: path.join(root, 'memory'),
    watcher: null, confluence: null, confluenceConfigured: false,
    workspaceRoot: root,
    spawnPi: () => { throw new Error('not stubbed') },
    mcpBroker,
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
    port, server, root, mcpBroker,
    async stop() { await new Promise((r) => server.close(() => r())); _resetWiringForTests() },
  }
}

async function jf(port, p, init = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, init)
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body }
}

/* ===== unit: overlay file ===== */

test('validateServerConfig: stdio shape', () => {
  const cfg = validateServerConfig({ id: 'my-tool', kind: 'stdio', command: 'uvx', args: ['my-tool'] })
  assert.ok(cfg)
  assert.equal(cfg.id, 'my-tool')
  assert.equal(cfg.kind, 'stdio')
})

test('validateServerConfig: rejects bad id', () => {
  assert.equal(validateServerConfig({ id: 'BAD', kind: 'stdio', command: 'uvx', args: [] }), null)
  assert.equal(validateServerConfig({ id: '', kind: 'stdio', command: 'uvx', args: [] }), null)
  assert.equal(validateServerConfig({ id: '1leading', kind: 'stdio', command: 'uvx', args: [] }), null)
})

test('validateServerConfig: rejects unknown kind', () => {
  assert.equal(validateServerConfig({ id: 'x', kind: 'ws', url: 'wss://x' }), null)
})

test('overlay round-trip: save → load yields the same servers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rt-'))
  saveOverlay(dir, [
    { id: 'a', kind: 'stdio', command: 'uvx', args: ['a'] },
    { id: 'b', kind: 'http', url: 'https://x' },
  ])
  const loaded = loadOverlay(dir)
  assert.equal(loaded.length, 2)
  assert.equal(loaded[0].id, 'a')
  assert.equal(loaded[1].id, 'b')
  // File should exist with mode 0600
  const st = fs.statSync(overlayPath(dir))
  assert.equal((st.mode & 0o777), 0o600)
})

test('addOverlayServer: rejects duplicate id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dup-'))
  addOverlayServer(dir, { id: 'a', kind: 'stdio', command: 'uvx', args: [] })
  assert.throws(() => addOverlayServer(dir, { id: 'a', kind: 'http', url: 'https://x' }))
})

test('removeOverlayServer: idempotent on miss', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rm-'))
  const result = removeOverlayServer(dir, 'never-was-there')
  assert.deepEqual(result, [])
})

test('loadOverlay: missing or malformed file returns empty list', () => {
  assert.deepEqual(loadOverlay('/nonexistent/path'), [])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bad-'))
  fs.writeFileSync(path.join(dir, 'mcp-servers.json'), '{not json')
  assert.deepEqual(loadOverlay(dir), [])
})

/* ===== HTTP integration ===== */

test('POST /api/mcp/servers — adds a stdio server, persists, broker sees it', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'my-tool', kind: 'stdio', command: 'uvx', args: ['my-tool'], env: { FOO: 'bar' } }),
    })
    assert.equal(r.status, 201)
    assert.equal(r.body.id, 'my-tool')
    // Listed via broker
    const list = await jf(ctx.port, '/api/mcp/servers')
    assert.ok(list.body.servers.some((s) => s.id === 'my-tool'))
    // Persisted on disk
    const onDisk = loadOverlay(ctx.root)
    assert.equal(onDisk.length, 1)
    assert.equal(onDisk[0].id, 'my-tool')
    assert.equal(onDisk[0].env?.FOO, 'bar')
  } finally { await ctx.stop() }
})

test('POST /api/mcp/servers — 400 on bad shape', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/mcp/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'BAD UPPERCASE' }),
    })
    assert.equal(r.status, 400)
  } finally { await ctx.stop() }
})

test('POST /api/mcp/servers — 409 when id collides with an existing seed entry', async () => {
  const ctx = await bootHttp({ seed: [{ id: 'context7', kind: 'stdio', command: 'x', args: [] }] })
  try {
    const r = await jf(ctx.port, '/api/mcp/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'context7', kind: 'stdio', command: 'uvx', args: [] }),
    })
    assert.equal(r.status, 409)
  } finally { await ctx.stop() }
})

test('DELETE /api/mcp/servers/:id — removes a user-added server', async () => {
  const ctx = await bootHttp()
  try {
    await jf(ctx.port, '/api/mcp/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'my-tool', kind: 'stdio', command: 'uvx', args: ['x'] }),
    })
    const r = await jf(ctx.port, '/api/mcp/servers/my-tool', { method: 'DELETE' })
    assert.equal(r.status, 200)
    assert.equal(r.body.deleted, true)
    // Gone from broker
    const list = await jf(ctx.port, '/api/mcp/servers')
    assert.ok(!list.body.servers.some((s) => s.id === 'my-tool'))
    // Gone from disk
    assert.deepEqual(loadOverlay(ctx.root), [])
  } finally { await ctx.stop() }
})

test('DELETE /api/mcp/servers/:id — 404 on unknown id', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/mcp/servers/ghost', { method: 'DELETE' })
    assert.equal(r.status, 404)
  } finally { await ctx.stop() }
})
