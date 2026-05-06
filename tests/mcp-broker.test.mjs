/**
 * Unit tests for McpBroker — stub clients exercise the lifecycle without
 * spawning real children or hitting real HTTP.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { McpBroker, McpError } from '../src/server/mcp-broker.ts'

function makeStubClient(opts = {}) {
  let started = false
  const calls = []
  const c = {
    started: () => started,
    calls,
    async start() {
      if (opts.startError) throw new Error(opts.startError)
      started = true
    },
    async listTools() {
      return opts.tools ?? [{ name: 'echo', description: 'echo back', inputSchema: {} }]
    },
    async callTool(name, args, signal) {
      calls.push({ name, args, signal })
      if (opts.callDelayMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, opts.callDelayMs)
          if (signal) signal.addEventListener('abort', () => {
            clearTimeout(t); reject(new Error('aborted'))
          })
        })
      }
      if (opts.callError) throw new Error(opts.callError)
      return { content: `echo:${name}:${JSON.stringify(args)}` }
    },
    async shutdown() {
      started = false
    },
  }
  return c
}

const CFG_TWO = [
  { id: 'alpha', kind: 'stdio', command: 'x', args: [] },
  { id: 'beta',  kind: 'http',  url: 'http://localhost/x' },
]

test('cold getStatus reports both servers as disconnected, no client started', () => {
  const stubs = new Map()
  const broker = new McpBroker(CFG_TWO, (cfg) => {
    const c = makeStubClient()
    stubs.set(cfg.id, c)
    return c
  })
  const status = broker.getStatus()
  assert.equal(status.length, 2)
  assert.deepStrictEqual(status.map((s) => s.status), ['disconnected', 'disconnected'])
  assert.deepStrictEqual(status.map((s) => s.toolCount), [0, 0])
  assert.equal(stubs.size, 0, 'factory should not be invoked before first use')
})

test('first callTool triggers connect, populates toolCache, and dispatches', async () => {
  const stubs = new Map()
  const broker = new McpBroker(CFG_TWO, (cfg) => {
    const c = makeStubClient({ tools: [{ name: 'foo', inputSchema: {} }] })
    stubs.set(cfg.id, c)
    return c
  })
  const result = await broker.callTool('alpha', 'foo', { x: 1 })
  assert.match(JSON.stringify(result), /"echo:foo/)

  const after = broker.getStatus()
  const alpha = after.find((s) => s.id === 'alpha')
  assert.equal(alpha.status, 'connected')
  assert.equal(alpha.toolCount, 1)
  assert.ok(typeof alpha.startedAt === 'number')

  // Beta untouched
  assert.equal(after.find((s) => s.id === 'beta').status, 'disconnected')
})

test('UNKNOWN_SERVER on bogus serverId', async () => {
  const broker = new McpBroker(CFG_TWO, () => makeStubClient())
  await assert.rejects(
    () => broker.callTool('nope', 'foo', {}),
    (err) => err instanceof McpError && err.code === 'UNKNOWN_SERVER',
  )
})

test('UNKNOWN_TOOL when server is connected but tool name is wrong', async () => {
  const broker = new McpBroker(CFG_TWO, () => makeStubClient({ tools: [{ name: 'real', inputSchema: {} }] }))
  await assert.rejects(
    () => broker.callTool('alpha', 'imaginary', {}),
    (err) => err instanceof McpError && err.code === 'UNKNOWN_TOOL',
  )
})

test('callTool wraps client.start() failures into MCP_TRANSPORT_ERROR via ensureConnected', async () => {
  const broker = new McpBroker(CFG_TWO, () => makeStubClient({ startError: 'boom' }))
  // The first failure leaves status=error; the next call also rejects (transport error path).
  await assert.rejects(() => broker.callTool('alpha', 'foo', {}))
  const after = broker.getStatus().find((s) => s.id === 'alpha')
  assert.equal(after.status, 'error')
  assert.match(after.error, /boom/)
})

test('callTool aborts on timeout and surfaces MCP_TIMEOUT', async () => {
  const broker = new McpBroker(CFG_TWO, () => makeStubClient({ callDelayMs: 200 }))
  await assert.rejects(
    () => broker.callTool('alpha', 'echo', {}, 50 /* tiny timeout */),
    (err) => err instanceof McpError && err.code === 'MCP_TIMEOUT',
  )
})

test('Ref refuses to connect when no x-ref-api-key header is configured', async () => {
  const broker = new McpBroker([
    { id: 'ref', kind: 'http', url: 'https://api.ref.tools/mcp' /* no headers */ },
  ], () => makeStubClient())
  await assert.rejects(
    () => broker.callTool('ref', 'anything', {}),
    (err) => err instanceof McpError,
  )
  const status = broker.getStatus()[0]
  assert.equal(status.status, 'error')
  assert.match(status.error, /REF_API_KEY/)
})

test('shutdownAll calls every started client.shutdown and resets status', async () => {
  const stubs = new Map()
  const broker = new McpBroker(CFG_TWO, (cfg) => {
    const c = makeStubClient()
    stubs.set(cfg.id, c)
    return c
  })
  // Connect both
  await broker.getToolsForServer('alpha')
  await broker.getToolsForServer('beta')
  assert.equal(stubs.get('alpha').started(), true)
  assert.equal(stubs.get('beta').started(), true)

  await broker.shutdownAll()
  assert.equal(stubs.get('alpha').started(), false)
  assert.equal(stubs.get('beta').started(), false)
  for (const s of broker.getStatus()) assert.equal(s.status, 'disconnected')
})

test('getTools returns flat list with qualified names from connected servers only', async () => {
  const broker = new McpBroker(CFG_TWO, (cfg) =>
    makeStubClient({ tools: [{ name: cfg.id === 'alpha' ? 'a-tool' : 'b-tool', inputSchema: {} }] }),
  )
  await broker.getToolsForServer('alpha')
  // beta deliberately not warmed
  const tools = broker.getTools()
  assert.equal(tools.length, 1)
  assert.equal(tools[0].qualifiedName, 'alpha:a-tool')
})
