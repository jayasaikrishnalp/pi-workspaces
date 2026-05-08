/**
 * Boot extensions/hive-self-mcp/server.ts as a child via the official MCP
 * StdioClientTransport, point it at a stub HTTP server, and verify the 9
 * tools are advertised + a couple representative calls round-trip.
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'extensions/hive-self-mcp/server.ts')

function startStubHive() {
  const calls = []
  const queue = []
  const defaultRes = { status: 200, body: { ok: true } }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: body ? safeJson(body) : undefined })
      const out = queue.shift() ?? defaultRes
      res.writeHead(out.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out.body))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({
        port: addr.port,
        calls,
        enqueue: (...rs) => { for (const r of rs) queue.push(r) },
        reset: () => { calls.length = 0; queue.length = 0 },
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

function safeJson(s) { try { return JSON.parse(s) } catch { return s } }

async function startMcpClient(env) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--import', 'tsx', SERVER],
    env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'test', version: '0.1.0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}

describe('hive-self-mcp', () => {
  let stub
  let portFile
  let tmpHome
  let realHome

  before(async () => {
    stub = await startStubHive()
    // Create a fake HOME with .pi-workspace/server.port pointing at the stub.
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-self-test-'))
    await fs.mkdir(path.join(tmpHome, '.pi-workspace'))
    portFile = path.join(tmpHome, '.pi-workspace', 'server.port')
    await fs.writeFile(portFile, String(stub.port))
    realHome = process.env.HOME
  })

  after(async () => {
    await stub.close()
    if (realHome) process.env.HOME = realHome
    await fs.rm(tmpHome, { recursive: true, force: true })
  })

  beforeEach(() => { stub.reset() })

  function envFor() {
    return {
      ...process.env,
      HOME: tmpHome,
      WORKSPACE_INTERNAL_TOKEN: 'test-token-abc',
    }
  }

  it('advertises 9 tools', async () => {
    const { client, transport } = await startMcpClient(envFor())
    try {
      const list = await client.listTools()
      const names = list.tools.map((t) => t.name).sort()
      assert.equal(list.tools.length, 9, names.join(','))
      assert.deepEqual(names, [
        'memory_delete', 'memory_list', 'memory_read', 'memory_write',
        'skill_create', 'skill_edit', 'skill_list', 'skill_patch', 'skill_read',
      ])
    } finally { await client.close(); await transport.close() }
  })

  it('memory_list GETs /api/memory with internal-token header', async () => {
    stub.enqueue({ status: 200, body: { entries: [{ name: 'project', size: 100, mtime: 12345 }] } })
    const { client, transport } = await startMcpClient(envFor())
    try {
      const res = await client.callTool({ name: 'memory_list', arguments: {} })
      assert.notEqual(res.isError, true)
      const last = stub.calls.at(-1)
      assert.equal(last.method, 'GET')
      assert.equal(last.url, '/api/memory')
      assert.equal(last.headers['x-workspace-internal-token'], 'test-token-abc')
      const body = JSON.parse(res.content[0].text)
      assert.equal(body.entries[0].name, 'project')
    } finally { await client.close(); await transport.close() }
  })

  it('memory_write PUTs /api/memory/:name with content body', async () => {
    stub.enqueue({ status: 200, body: { name: 'user', size: 50, mtime: 99 } })
    const { client, transport } = await startMcpClient(envFor())
    try {
      const res = await client.callTool({
        name: 'memory_write',
        arguments: { name: 'user', content: 'user prefers terse answers' },
      })
      assert.notEqual(res.isError, true)
      const last = stub.calls.at(-1)
      assert.equal(last.method, 'PUT')
      assert.equal(last.url, '/api/memory/user')
      assert.deepEqual(last.body, { content: 'user prefers terse answers' })
    } finally { await client.close(); await transport.close() }
  })

  it('skill_patch PATCHes /api/skills/:name with old_string + new_string', async () => {
    stub.enqueue({ status: 200, body: { name: 'foo', path: 'foo/SKILL.md', replacements: 1, strategy: 'exact' } })
    const { client, transport } = await startMcpClient(envFor())
    try {
      const res = await client.callTool({
        name: 'skill_patch',
        arguments: { name: 'foo', old_string: 'old', new_string: 'new', replace_all: true },
      })
      assert.notEqual(res.isError, true)
      const last = stub.calls.at(-1)
      assert.equal(last.method, 'PATCH')
      assert.equal(last.url, '/api/skills/foo')
      // JSON.stringify drops `undefined`, so file_path is omitted on the wire.
      assert.deepEqual(last.body, { old_string: 'old', new_string: 'new', replace_all: true })
      const body = JSON.parse(res.content[0].text)
      assert.equal(body.strategy, 'exact')
    } finally { await client.close(); await transport.close() }
  })

  it('returns NO_INTERNAL_TOKEN error when env is missing', async () => {
    const env = { ...process.env, HOME: tmpHome }
    delete env.WORKSPACE_INTERNAL_TOKEN
    const { client, transport } = await startMcpClient(env)
    try {
      const res = await client.callTool({ name: 'memory_list', arguments: {} })
      assert.equal(res.isError, true)
      assert.match(res.content[0].text, /NO_INTERNAL_TOKEN/)
    } finally { await client.close(); await transport.close() }
  })
})
