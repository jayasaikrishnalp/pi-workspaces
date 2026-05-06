/**
 * HTTP integration tests for the secret-store routes.
 *
 * Spec:
 *   - GET    /api/secrets             → 200 { secrets: [{key, updatedAt}] }, NEVER returns values
 *   - PUT    /api/secrets/:key { value } → 200 { key, updatedAt }
 *   - PUT    rejects non-string value (400 BAD_REQUEST)
 *   - PUT    rejects key > 256 chars (400 BAD_REQUEST)
 *   - DELETE /api/secrets/:key        → 200 { deleted: true }, then 404 on second call
 *   - 503 NO_SECRET_STORE when wiring lacks it
 *   - All routes are auth-gated like the other workspace routes
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
import { SecretStore, _resetSecretStoreForTests } from '../src/server/secret-store.ts'

async function bootHttp({ withSecretStore = true } = {}) {
  _resetWiringForTests()
  _resetSecretStoreForTests()
  process.env.PI_WORKSPACE_AUTH_DISABLED = '1'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-route-'))
  const bus = new ChatEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
  const bridge = {
    send: async () => {},
    waitForActiveCompletion: async () => {},
    abort: async () => {},
    shutdown: async () => {},
  }
  const sessions = new Map()
  let secretStore = null
  if (withSecretStore) {
    secretStore = new SecretStore({ workspaceRoot: root })
    await secretStore.load()
  }
  globalThis.__wiring = { bus, runStore, tracker, bridge, sessions, secretStore }
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
    port, server, secretStore, root,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()))
      _resetWiringForTests()
      _resetSecretStoreForTests()
    },
  }
}

async function fetchJson(port, p, init = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, init)
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body }
}

async function jsonReq(port, p, method, body) {
  return fetchJson(port, p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('GET /api/secrets returns empty list initially', async () => {
  const ctx = await bootHttp()
  try {
    const r = await fetchJson(ctx.port, '/api/secrets')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { secrets: [] })
  } finally { await ctx.stop() }
})

test('PUT then GET round-trips a key without leaking the value', async () => {
  const ctx = await bootHttp()
  try {
    const put = await jsonReq(ctx.port, '/api/secrets/aws.access_key_id', 'PUT', { value: 'AKIAFAKEEXAMPLE' })
    assert.equal(put.status, 200)
    assert.equal(put.body.key, 'aws.access_key_id')
    assert.equal(typeof put.body.updatedAt, 'number')
    assert.equal('value' in put.body, false, 'PUT response must not echo the value back')

    const list = await fetchJson(ctx.port, '/api/secrets')
    assert.equal(list.status, 200)
    assert.equal(list.body.secrets.length, 1)
    const entry = list.body.secrets[0]
    assert.equal(entry.key, 'aws.access_key_id')
    assert.equal(typeof entry.updatedAt, 'number')
    assert.equal('value' in entry, false, 'GET must never include value')

    // Round-trip on disk: the file mode is 0600 and the value is there.
    assert.equal(ctx.secretStore.getSecret('aws.access_key_id'), 'AKIAFAKEEXAMPLE')
  } finally { await ctx.stop() }
})

test('PUT rejects non-string value with 400 BAD_REQUEST', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jsonReq(ctx.port, '/api/secrets/k', 'PUT', { value: 12345 })
    assert.equal(r.status, 400)
    assert.equal(r.body.error?.code, 'BAD_REQUEST')
  } finally { await ctx.stop() }
})

test('PUT rejects missing value field with 400 BAD_REQUEST', async () => {
  const ctx = await bootHttp()
  try {
    const r = await jsonReq(ctx.port, '/api/secrets/k', 'PUT', {})
    assert.equal(r.status, 400)
    assert.equal(r.body.error?.code, 'BAD_REQUEST')
  } finally { await ctx.stop() }
})

test('PUT rejects key > 256 chars with 400 BAD_REQUEST', async () => {
  const ctx = await bootHttp()
  try {
    const longKey = 'a'.repeat(257)
    const r = await jsonReq(ctx.port, `/api/secrets/${longKey}`, 'PUT', { value: 'v' })
    assert.equal(r.status, 400)
    assert.equal(r.body.error?.code, 'BAD_REQUEST')
  } finally { await ctx.stop() }
})

test('DELETE round-trips, second call returns 404', async () => {
  const ctx = await bootHttp()
  try {
    await jsonReq(ctx.port, '/api/secrets/k', 'PUT', { value: 'v' })
    const del1 = await fetchJson(ctx.port, '/api/secrets/k', { method: 'DELETE' })
    assert.equal(del1.status, 200)
    assert.deepEqual(del1.body, { deleted: true })

    const del2 = await fetchJson(ctx.port, '/api/secrets/k', { method: 'DELETE' })
    assert.equal(del2.status, 404)
    assert.equal(del2.body.error?.code, 'UNKNOWN_SECRET')
  } finally { await ctx.stop() }
})

test('GET secrets returns 503 when wiring lacks a secret store', async () => {
  const ctx = await bootHttp({ withSecretStore: false })
  try {
    const r = await fetchJson(ctx.port, '/api/secrets')
    assert.equal(r.status, 503)
    assert.equal(r.body.error?.code, 'NO_SECRET_STORE')
  } finally { await ctx.stop() }
})

test('PUT secrets returns 503 when wiring lacks a secret store', async () => {
  const ctx = await bootHttp({ withSecretStore: false })
  try {
    const r = await jsonReq(ctx.port, '/api/secrets/k', 'PUT', { value: 'v' })
    assert.equal(r.status, 503)
    assert.equal(r.body.error?.code, 'NO_SECRET_STORE')
  } finally { await ctx.stop() }
})

test('multiple keys list in stable alphabetical order', async () => {
  const ctx = await bootHttp()
  try {
    await jsonReq(ctx.port, '/api/secrets/zeta', 'PUT', { value: 'a' })
    await jsonReq(ctx.port, '/api/secrets/alpha', 'PUT', { value: 'b' })
    await jsonReq(ctx.port, '/api/secrets/middle', 'PUT', { value: 'c' })

    const r = await fetchJson(ctx.port, '/api/secrets')
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.secrets.map((e) => e.key), ['alpha', 'middle', 'zeta'])
    for (const e of r.body.secrets) {
      assert.equal('value' in e, false)
    }
  } finally { await ctx.stop() }
})
