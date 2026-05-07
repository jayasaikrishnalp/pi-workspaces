/**
 * HTTP integration tests for /api/wiki-ui/* — static file passthrough that
 * surfaces the existing llm-wiki-ui app inside Hive.
 *
 * Spec:
 *   - GET /api/wiki-ui/<file>   → 200 + file contents + correct Content-Type
 *   - GET on a path that escapes the root (../etc) → 400 BAD_PATH
 *   - GET on a missing file     → 404 NOT_FOUND
 *   - GET when wikiUiRoot null  → 503 WIKI_UI_DISABLED
 *   - URI-encoded spaces work   ("LLM%20Wiki.html")
 *   - Auth-gated (covered by global PI_WORKSPACE_AUTH_DISABLED=1)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { _resetWiringForTests } from '../src/server/wiring.ts'
import { startServer } from '../src/server.ts'
import { RunStore } from '../src/server/run-store.ts'
import { ChatEventBus } from '../src/server/chat-event-bus.ts'
import { SendRunTracker } from '../src/server/send-run-tracker.ts'

async function bootHttp({ withWikiUi = true } = {}) {
  _resetWiringForTests()
  process.env.PI_WORKSPACE_AUTH_DISABLED = '1'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-ui-route-'))
  let wikiUiRoot = null
  if (withWikiUi) {
    wikiUiRoot = path.join(root, 'llm-wiki-ui')
    fs.mkdirSync(wikiUiRoot, { recursive: true })
    fs.writeFileSync(path.join(wikiUiRoot, 'LLM Wiki.html'), '<!doctype html><html><body>hello</body></html>')
    fs.writeFileSync(path.join(wikiUiRoot, 'data.js'), 'const X = 1;')
    fs.writeFileSync(path.join(wikiUiRoot, 'app.css'), 'body { color: red; }')
  }
  const bus = new ChatEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
  const bridge = { send: async () => {}, waitForActiveCompletion: async () => {}, abort: async () => {}, shutdown: async () => {} }
  globalThis.__wiring = { bus, runStore, tracker, bridge, sessions: new Map(), wikiUiRoot }
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
    port, server, wikiUiRoot,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()))
      _resetWiringForTests()
    },
  }
}

async function fetchRaw(port, p) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`)
  const text = await r.text()
  return { status: r.status, body: text, contentType: r.headers.get('content-type') }
}

test('GET /api/wiki-ui/data.js returns the file with text/javascript content-type', async () => {
  const ctx = await bootHttp()
  try {
    const r = await fetchRaw(ctx.port, '/api/wiki-ui/data.js')
    assert.equal(r.status, 200)
    assert.equal(r.body, 'const X = 1;')
    assert.match(r.contentType ?? '', /javascript/)
  } finally { await ctx.stop() }
})

test('GET /api/wiki-ui/LLM%20Wiki.html serves the html (URI-encoded space)', async () => {
  const ctx = await bootHttp()
  try {
    const r = await fetchRaw(ctx.port, '/api/wiki-ui/LLM%20Wiki.html')
    assert.equal(r.status, 200)
    assert.match(r.body, /<html>/)
    assert.match(r.contentType ?? '', /html/)
  } finally { await ctx.stop() }
})

test('GET /api/wiki-ui/app.css → text/css', async () => {
  const ctx = await bootHttp()
  try {
    const r = await fetchRaw(ctx.port, '/api/wiki-ui/app.css')
    assert.equal(r.status, 200)
    assert.match(r.contentType ?? '', /css/)
  } finally { await ctx.stop() }
})

test('path traversal is blocked with 400', async () => {
  const ctx = await bootHttp()
  try {
    const r = await fetchRaw(ctx.port, '/api/wiki-ui/..%2F..%2Fetc%2Fpasswd')
    assert.equal(r.status, 400)
  } finally { await ctx.stop() }
})

test('missing file → 404', async () => {
  const ctx = await bootHttp()
  try {
    const r = await fetchRaw(ctx.port, '/api/wiki-ui/nope.html')
    assert.equal(r.status, 404)
  } finally { await ctx.stop() }
})

test('wikiUiRoot=null → 503 WIKI_UI_DISABLED', async () => {
  const ctx = await bootHttp({ withWikiUi: false })
  try {
    const r = await fetchRaw(ctx.port, '/api/wiki-ui/anything.html')
    assert.equal(r.status, 503)
    assert.match(r.body, /WIKI_UI_DISABLED/)
  } finally { await ctx.stop() }
})
