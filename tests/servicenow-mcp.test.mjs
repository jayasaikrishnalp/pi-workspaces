/**
 * Servicenow MCP server tests. Boot the server as a child via the official
 * StdioClientTransport (no manual JSON-RPC framing needed) against a stub
 * SNOW HTTP server bound to a random localhost port. Asserts:
 *
 *   1. tools/list returns all 11 tools
 *   2. get_incident GETs the right URL with display values + Basic auth
 *   3. resolve_incident PATCHes the four-field quartet
 *   4. get_ritm extracts the right fields
 *   5. NO_CREDS surfaces when env is missing
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'extensions/servicenow-mcp/server.ts')

/**
 * Stub SNOW server. Pushes onto a response queue with `enqueue(...)` and
 * pops one per request. If the queue runs dry it falls back to
 * `defaultResponse` (200 + empty result).
 */
function startStubSnow() {
  const calls = []
  const queue = []
  const defaultResponse = { status: 200, body: { result: {} } }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body ? safeJson(body) : undefined,
      })
      const out = queue.shift() ?? defaultResponse
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
        close: () => new Promise((res) => server.close(res)),
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
  const client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}

describe('servicenow-mcp', () => {
  let stub
  before(async () => { stub = await startStubSnow() })
  after(async () => { await stub.close() })
  beforeEach(() => { stub.reset() })

  function envFor() {
    return {
      ...process.env,
      SNOW_INSTANCE: `http://127.0.0.1:${stub.port}`,
      SNOW_USER: 'tester',
      SNOW_PASS: 'secret',
    }
  }

  it('lists all 11 tools via tools/list', async () => {
    const { client, transport } = await startMcpClient(envFor())
    try {
      const list = await client.listTools()
      const names = list.tools.map((t) => t.name).sort()
      assert.equal(list.tools.length, 11, `expected 11 tools, got ${list.tools.length}: ${names.join(',')}`)
      assert.ok(names.includes('get_ritm'))
      assert.ok(names.includes('get_incident'))
      assert.ok(names.includes('resolve_incident'))
      assert.ok(names.includes('find_user'))
      assert.ok(names.includes('list_tasks_for_ci'))
    } finally {
      await client.close()
      await transport.close()
    }
  })

  it('get_incident GETs /api/now/table/incident with sysparm_query=number= and Basic auth', async () => {
    stub.enqueue({ status: 200, body: { result: [{ number: 'INC1', sys_id: 'abc', state: { display_value: 'New', value: '1' } }] } })
    const { client, transport } = await startMcpClient(envFor())
    try {
      const res = await client.callTool({ name: 'get_incident', arguments: { number: 'INC1' } })
      assert.notEqual(res.isError, true, JSON.stringify(res))
      const last = stub.calls.at(-1)
      assert.equal(last.method, 'GET')
      assert.match(last.url, /^\/api\/now\/table\/incident\?/)
      assert.match(last.url, /sysparm_query=number%3DINC1/)
      assert.match(last.url, /sysparm_display_value=true/)
      const expectedAuth = 'Basic ' + Buffer.from('tester:secret').toString('base64')
      assert.equal(last.headers.authorization, expectedAuth)
      const text = JSON.parse(res.content[0].text)
      assert.equal(text.number, 'INC1')
      assert.equal(text.state.display_value, 'New')
    } finally {
      await client.close()
      await transport.close()
    }
  })

  it('resolve_incident PATCHes state=6 + close_code + close_notes together', async () => {
    // 1st call: number → sys_id lookup. 2nd call: PATCH.
    stub.enqueue(
      { status: 200, body: { result: [{ sys_id: 'incsys' }] } },
      { status: 200, body: { result: { number: 'INC9', state: { display_value: 'Resolved', value: '6' } } } },
    )
    const { client, transport } = await startMcpClient(envFor())
    try {
      const res = await client.callTool({
        name: 'resolve_incident',
        arguments: { number: 'INC9', close_code: 'Solved (Permanently)', close_notes: 'all good', assigned_to: 'me' },
      })
      assert.notEqual(res.isError, true, JSON.stringify(res))
      const patch = stub.calls.find((c) => c.method === 'PATCH')
      assert.ok(patch, 'expected a PATCH call')
      assert.match(patch.url, /^\/api\/now\/table\/incident\/incsys/)
      assert.equal(patch.body.state, '6')
      assert.equal(patch.body.close_code, 'Solved (Permanently)')
      assert.equal(patch.body.close_notes, 'all good')
      assert.equal(patch.body.assigned_to, 'me')
    } finally {
      await client.close()
      await transport.close()
    }
  })

  it('get_ritm fetches sc_req_item by number and surfaces structured fields', async () => {
    stub.enqueue({
      status: 200,
      body: {
        result: [{
          number: 'RITM1873427',
          sys_id: 'ritmsys',
          short_description: 'Patch host foo.example.com',
          state: { display_value: 'Open', value: '1' },
          stage: { display_value: 'Request Approved', value: 'request_approved' },
          requested_for: { display_value: 'Jane Doe', value: 'usr1' },
          opened_by: { display_value: 'Bob Caller', value: 'usr2' },
          request: { display_value: 'REQ987', value: 'reqsys' },
        }],
      },
    })
    const { client, transport } = await startMcpClient(envFor())
    try {
      const res = await client.callTool({ name: 'get_ritm', arguments: { number: 'RITM1873427' } })
      assert.notEqual(res.isError, true, JSON.stringify(res))
      const last = stub.calls.at(-1)
      assert.match(last.url, /^\/api\/now\/table\/sc_req_item\?/)
      assert.match(last.url, /sysparm_query=number%3DRITM1873427/)
      const text = JSON.parse(res.content[0].text)
      assert.equal(text.number, 'RITM1873427')
      assert.equal(text.requested_for.display_value, 'Jane Doe')
      assert.equal(text.stage.display_value, 'Request Approved')
    } finally {
      await client.close()
      await transport.close()
    }
  })

  it('returns NO_CREDS error text when env vars are missing', async () => {
    const env = { ...process.env, SNOW_INSTANCE: '', SNOW_USER: '', SNOW_PASS: '' }
    const { client, transport } = await startMcpClient(env)
    try {
      const res = await client.callTool({ name: 'get_incident', arguments: { number: 'INC1' } })
      assert.equal(res.isError, true)
      assert.match(res.content[0].text, /NO_CREDS/)
    } finally {
      await client.close()
      await transport.close()
    }
  })
})
