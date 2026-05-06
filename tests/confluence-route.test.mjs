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

class FakeConfluence {
  constructor(opts = {}) {
    this.searchImpl = opts.searchImpl ?? (async () => [])
    this.getPageImpl = opts.getPageImpl ?? (async (id) => ({ id, title: 't', content: `<external_content trusted="false" source="confluence" page-id="${id}">x</external_content>`, sourceUrl: '' }))
    this.searchCalls = []
    this.getPageCalls = []
  }
  async search(input) {
    this.searchCalls.push(input)
    return this.searchImpl(input)
  }
  async getPage(id, max) {
    this.getPageCalls.push({ id, max })
    return this.getPageImpl(id, max)
  }
}

async function bootHttp({ confluence = new FakeConfluence(), confluenceConfigured = true } = {}) {
  _resetWiringForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confluence-route-'))
  const skillsDir = path.join(root, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  const bus = new ChatEventBus()
  const kbBus = new KbEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
  const bridge = {
    send: async () => {},
    waitForActiveCompletion: async () => {},
    abort: async () => {},
    shutdown: async () => {},
  }
  globalThis.__wiring = {
    bus, runStore, tracker, bridge,
    sessions: new Map(),
    kbBus,
    kbRoot: root,
    skillsDir,
    agentsDir: path.join(root, 'agents'),
    workflowsDir: path.join(root, 'workflows'),
    memoryDir: path.join(root, 'memory'),
    watcher: null,
    confluence: confluenceConfigured ? confluence : null,
    confluenceConfigured,
    spawnPi: () => { throw new Error('test wiring: spawnPi not stubbed') },
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
    port, server, confluence,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()))
      _resetWiringForTests()
    },
  }
}

async function jsonFetch(port, path, init = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, init)
  const text = await r.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: r.status, body }
}

test('POST /api/confluence/search → 200 with hits when client returns hits', async () => {
  const fake = new FakeConfluence({
    searchImpl: async () => [{ id: '1', title: 'A', snippet: 's', url: 'u' }],
  })
  const ctx = await bootHttp({ confluence: fake })
  try {
    const r = await jsonFetch(ctx.port, '/api/confluence/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'cobra', limit: 3 }),
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.hits.length, 1)
    assert.equal(fake.searchCalls.length, 1)
    assert.equal(fake.searchCalls[0].query, 'cobra')
    assert.equal(fake.searchCalls[0].limit, 3)
  } finally {
    await ctx.stop()
  }
})

test('POST /api/confluence/search → 503 when confluence is not configured', async () => {
  const ctx = await bootHttp({ confluence: null, confluenceConfigured: false })
  try {
    const r = await jsonFetch(ctx.port, '/api/confluence/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    })
    assert.equal(r.status, 503)
    assert.equal(r.body.error.code, 'CONFLUENCE_UNAVAILABLE')
  } finally {
    await ctx.stop()
  }
})

test('POST /api/confluence/search: missing query → 400 INVALID_INPUT', async () => {
  const fake = new FakeConfluence({
    searchImpl: async () => {
      const e = new (await import('../src/server/confluence-client.ts')).ConfluenceError(
        'INVALID_INPUT',
        'query must be a non-empty string',
      )
      throw e
    },
  })
  const ctx = await bootHttp({ confluence: fake })
  try {
    const r = await jsonFetch(ctx.port, '/api/confluence/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'INVALID_INPUT')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/confluence/page/:pageId — non-numeric pageId → 400 at the route layer (before client is touched)', async () => {
  // Our path matcher allows the segment to be any string. The route validates
  // /^\d+$/ before dispatching to the client.
  const fake = new FakeConfluence()
  const ctx = await bootHttp({ confluence: fake })
  try {
    const r = await jsonFetch(ctx.port, '/api/confluence/page/abc')
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'INVALID_PAGE_ID')
    // Client must not have been called.
    assert.equal(fake.getPageCalls.length, 0)
  } finally {
    await ctx.stop()
  }
})

test('GET /api/confluence/page/:pageId — numeric pageId returns wrapped content', async () => {
  const fake = new FakeConfluence({
    getPageImpl: async (id) => ({
      id,
      title: 'My Page',
      content: `<external_content trusted="false" source="confluence" page-id="${id}"><p>hi</p></external_content>`,
      sourceUrl: 'https://wkengineering.atlassian.net/wiki/x',
    }),
  })
  const ctx = await bootHttp({ confluence: fake })
  try {
    const r = await jsonFetch(ctx.port, '/api/confluence/page/12345')
    assert.equal(r.status, 200)
    assert.equal(r.body.id, '12345')
    assert.match(r.body.content, /<external_content trusted="false" source="confluence" page-id="12345">/)
  } finally {
    await ctx.stop()
  }
})

test('GET /api/confluence/page/<encoded-traversal> → 400 INVALID_PAGE_ID at the dispatch guard', async () => {
  // Path-traversal that the fetch client cannot normalize away (uses %2F for
  // the slashes). The dispatcher's raw-URL guard catches it and returns 400
  // BEFORE any route match, so the client is never called.
  const fake = new FakeConfluence()
  const ctx = await bootHttp({ confluence: fake })
  try {
    // %2e%2e%2f = "../" — survives Node fetch's path normalization.
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/confluence/page/%2e%2e%2f%2e%2e%2fetc%2fpasswd`)
    assert.equal(res.status, 400, `expected 400, got ${res.status}`)
    const body = await res.json()
    assert.equal(body.error.code, 'INVALID_PAGE_ID')
    assert.equal(fake.getPageCalls.length, 0, 'no outbound call should occur')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/confluence/page/..%2f → also rejected (mixed-case encoding)', async () => {
  const fake = new FakeConfluence()
  const ctx = await bootHttp({ confluence: fake })
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/confluence/page/..%2Fetc%2Fpasswd`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error.code, 'INVALID_PAGE_ID')
    assert.equal(fake.getPageCalls.length, 0)
  } finally {
    await ctx.stop()
  }
})

test('GET /api/confluence/page/123?maxChars=-1 clamps to 256 (not rejected)', async () => {
  const fake = new FakeConfluence({
    getPageImpl: async (id, max) => ({
      id,
      title: 't',
      content: `<external_content trusted="false" source="confluence" page-id="${id}">x</external_content>`,
      sourceUrl: '',
    }),
  })
  const ctx = await bootHttp({ confluence: fake })
  try {
    const r = await jsonFetch(ctx.port, '/api/confluence/page/123?maxChars=-1')
    assert.equal(r.status, 200, `expected 200 (clamp), got ${r.status}`)
    assert.equal(fake.getPageCalls.length, 1)
    assert.equal(fake.getPageCalls[0].max, 256, `expected clamp to 256, got ${fake.getPageCalls[0].max}`)
  } finally {
    await ctx.stop()
  }
})

test('GET /api/confluence/page/123?maxChars=99999 clamps to 16000', async () => {
  const fake = new FakeConfluence()
  const ctx = await bootHttp({ confluence: fake })
  try {
    const r = await jsonFetch(ctx.port, '/api/confluence/page/123?maxChars=99999')
    assert.equal(r.status, 200)
    assert.equal(fake.getPageCalls[0].max, 16_000)
  } finally {
    await ctx.stop()
  }
})

test('GET /api/confluence/page/123?maxChars=abc → 400 INVALID_INPUT', async () => {
  const fake = new FakeConfluence()
  const ctx = await bootHttp({ confluence: fake })
  try {
    const r = await jsonFetch(ctx.port, '/api/confluence/page/123?maxChars=abc')
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'INVALID_INPUT')
  } finally {
    await ctx.stop()
  }
})

test('Client error codes translate to expected HTTP statuses', async () => {
  const { ConfluenceError } = await import('../src/server/confluence-client.ts')
  const cases = [
    ['AUTH_REQUIRED', 401],
    ['FORBIDDEN', 403],
    ['RATE_LIMITED', 429],
    ['TIMEOUT', 504],
    ['EXTERNAL_API_ERROR', 502],
  ]
  for (const [code, status] of cases) {
    const fake = new FakeConfluence({ searchImpl: async () => { throw new ConfluenceError(code, 'x') } })
    const ctx = await bootHttp({ confluence: fake })
    try {
      const r = await jsonFetch(ctx.port, '/api/confluence/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'x' }),
      })
      assert.equal(r.status, status, `code=${code}`)
      assert.equal(r.body.error.code, code)
    } finally {
      await ctx.stop()
    }
  }
})
