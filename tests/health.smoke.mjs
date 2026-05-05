import test from 'node:test'
import assert from 'node:assert/strict'
import { startServer, killServer, fetchPath } from './_helpers.mjs'

test('health: healthy response shape', async () => {
  const handle = await startServer()
  try {
    const r = await fetchPath(handle.port, '/api/health')
    assert.equal(r.status, 200, 'status must be 200')
    assert.ok(r.headers.get('content-type')?.includes('application/json'), 'content-type must be JSON')
    assert.equal(typeof r.body, 'object', 'body must parse as JSON')
    assert.equal(r.body.ok, true, 'ok must be true')
    assert.match(r.body.version, /^\d+\.\d+\.\d+$/, 'version must be semver')
  } finally { await killServer(handle) }
})

test('health: endpoint requires no authentication', async () => {
  const handle = await startServer()
  try {
    const r = await fetchPath(handle.port, '/api/health', { headers: { 'X-Test': 'no-auth' } })
    assert.equal(r.status, 200, 'must be 200, never 401')
  } finally { await killServer(handle) }
})

test('health: wrong method returns 405 with details', async () => {
  const handle = await startServer()
  try {
    const r = await fetchPath(handle.port, '/api/health', { method: 'POST' })
    assert.equal(r.status, 405, 'status must be 405')
    assert.equal(r.headers.get('allow'), 'GET', 'Allow header must be "GET"')
    assert.equal(typeof r.body, 'object', 'body must parse as JSON')
    assert.equal(r.body.error?.code, 'METHOD_NOT_ALLOWED', 'error.code must be METHOD_NOT_ALLOWED')
    assert.equal(typeof r.body.error?.message, 'string')
    assert.equal(typeof r.body.error?.ts, 'number')
    // Locked spec §2.6: error.details is part of the contract
    assert.ok(r.body.error?.details, 'error.details must be present per spec §2.6')
    assert.equal(r.body.error.details.path, '/api/health')
    assert.equal(r.body.error.details.method, 'POST')
    assert.deepEqual(r.body.error.details.allowed, ['GET'])
  } finally { await killServer(handle) }
})
