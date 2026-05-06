/**
 * HTTP integration tests for the MCP routes. Stubs the broker via the
 * factory so no real children spawn and no real fetches go out.
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

function stubClient(opts = {}) {
  let started = false
  return {
    async start() {
      if (opts.startError) throw new Error(opts.startError)
      started = true
    },
    async listTools() {
      return opts.tools ?? [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }]
    },
    async callTool(name, args, signal) {
      if (opts.callDelayMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, opts.callDelayMs)
          if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
        })
      }
      if (opts.callError) throw new Error(opts.callError)
      return { content: `echo:${name}`, args }
    },
    async shutdown() { started = false },
    started: () => started,
  }
}

async function bootHttp({ brokerOpts = {} } = {}) {
  _resetWiringForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-route-'))
  const skillsDir = path.join(root, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  const bus = new ChatEventBus()
  const kbBus = new KbEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
  const bridge = {
    send: async () => {}, waitForActiveCompletion: async () => {}, abort: async () => {}, shutdown: async () => {},
  }
  const factory = (cfg) => stubClient(brokerOpts[cfg.id] ?? {})
  const cfgs = [
    { id: 'alpha', kind: 'stdio', command: 'x', args: [] },
    { id: 'beta',  kind: 'http',  url: 'http://localhost/x' },
  ]
  const mcpBroker = new McpBroker(cfgs, factory)

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
    port, server, mcpBroker,
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

test('GET /api/mcp/servers — cold list reports disconnected', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/mcp/servers')
    assert.equal(r.status, 200)
    assert.equal(r.body.servers.length, 2)
    for (const s of r.body.servers) assert.equal(s.status, 'disconnected')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/mcp/servers?warm=true — connects all and reports counts', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/mcp/servers?warm=true')
    assert.equal(r.status, 200)
    for (const s of r.body.servers) {
      assert.equal(s.status, 'connected')
      assert.equal(s.toolCount, 1)
    }
  } finally {
    await ctx.stop()
  }
})

test('GET /api/mcp/tools — flat list with qualifiedName from both servers', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/mcp/tools')
    assert.equal(r.status, 200)
    const names = r.body.tools.map((t) => t.qualifiedName).sort()
    assert.deepStrictEqual(names, ['alpha:echo', 'beta:echo'])
    assert.equal(r.body.tools[0].serverId, 'alpha')
  } finally {
    await ctx.stop()
  }
})

test('POST /api/mcp/call — happy path returns tool result', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/mcp/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: 'alpha', toolName: 'echo', args: { x: 1 } }),
    })
    assert.equal(r.status, 200)
    assert.match(r.body.result.content, /^echo:echo/)
    assert.deepStrictEqual(r.body.result.args, { x: 1 })
  } finally {
    await ctx.stop()
  }
})

test('POST /api/mcp/call — UNKNOWN_SERVER → 400', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/mcp/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: 'gamma', toolName: 'echo', args: {} }),
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'UNKNOWN_SERVER')
  } finally {
    await ctx.stop()
  }
})

test('POST /api/mcp/call — UNKNOWN_TOOL → 400', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/mcp/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: 'alpha', toolName: 'imaginary', args: {} }),
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'UNKNOWN_TOOL')
  } finally {
    await ctx.stop()
  }
})

test('POST /api/mcp/call — missing serverId or toolName → 400', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jf(ctx.port, '/api/mcp/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: 'alpha' }),
    })
    assert.equal(r.status, 400)
  } finally {
    await ctx.stop()
  }
})

test('POST /api/mcp/call — start failure → 502 MCP_TRANSPORT_ERROR', async () => {
  const ctx = await bootHttp({ brokerOpts: { alpha: { startError: 'spawn enotrace' } } })
  try {
    const r = await jf(ctx.port, '/api/mcp/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: 'alpha', toolName: 'echo', args: {} }),
    })
    assert.equal(r.status, 502)
    assert.equal(r.body.error.code, 'MCP_TRANSPORT_ERROR')
  } finally {
    await ctx.stop()
  }
})
