import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { once } from 'node:events'
import path from 'node:path'
import url from 'node:url'
import { startServer, killServer, fetchPath } from './_helpers.mjs'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const SERVER_PATH = path.resolve(__dirname, '..', 'src', 'server.ts')

test('server: boots on configured port (PORT=8767)', async () => {
  // Spec scenario uses literal PORT=8767. Use that exactly.
  const handle = await startServer({ port: 8767 })
  try {
    assert.equal(handle.port, 8767, `must bind on configured port 8767, got ${handle.port}`)
    const r = await fetchPath(handle.port, '/api/health')
    assert.equal(r.status, 200, 'health must respond on the bound port')
    assert.match(
      handle.getStdout(),
      /listening on http:\/\/127\.0\.0\.1:8767 \(v\d+\.\d+\.\d+\)/,
      'startup log must include port + version',
    )
  } finally { await killServer(handle) }
})

test('server: default port when PORT unset (port 8766)', async (t) => {
  // Spawn manually here so we can spawn WITHOUT PORT set.
  const env = { ...process.env, NO_COLOR: '1' }
  delete env.PORT
  const child = spawn('node', ['--import', 'tsx', SERVER_PATH], {
    cwd: path.resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    detached: true,
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (d) => { stdout += d.toString() })
  child.stderr.on('data', (d) => { stderr += d.toString() })
  try {
    const start = Date.now()
    while (Date.now() - start < 5000) {
      if (stdout.includes('listening on') || stderr.includes('EADDRINUSE')) break
      if (child.exitCode != null) break
      await sleep(50)
    }
    if (stderr.includes('EADDRINUSE')) {
      t.skip('port 8766 already in use; skipping default-port scenario')
      return
    }
    assert.match(stdout, /listening on http:\/\/127\.0\.0\.1:8766/, 'must default to port 8766')
    const r = await fetchPath(8766, '/api/health')
    assert.equal(r.status, 200)
  } finally {
    await killServer({ child }, 'SIGTERM')
  }
})

test('server: port collision exits non-zero with EADDRINUSE (port 8766, no PORT override)', async (t) => {
  // Spec scenario: another process already binds 127.0.0.1:8766; workspace
  // started without a PORT override; server logs EADDRINUSE + bound port and exits non-zero.
  let hog
  try {
    hog = net.createServer().listen(8766, '127.0.0.1')
    await once(hog, 'listening')
  } catch (e) {
    t.skip(`could not bind hog on port 8766: ${e.message}`)
    return
  }
  try {
    const env = { ...process.env, NO_COLOR: '1' }
    delete env.PORT  // Spec: "without a PORT override"
    const child = spawn('node', ['--import', 'tsx', SERVER_PATH], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: true,
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d.toString() })

    // Register exit BEFORE spawn semantics could matter; child may exit fast.
    const exitPromise = once(child, 'exit')
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }, 5000)
    const [code, signal] = await exitPromise
    clearTimeout(timer)

    assert.ok(!timedOut, 'child must exit on its own within 5s, not be force-killed')
    assert.equal(typeof code, 'number', `exit must produce numeric code, got code=${code} signal=${signal}`)
    assert.notEqual(code, 0, `exit code must be non-zero on EADDRINUSE, got ${code}`)
    assert.match(stderr, /EADDRINUSE/, 'stderr must mention EADDRINUSE')
    assert.match(stderr, /port=8766/, 'stderr should hint at the bound port')
  } finally {
    hog.close()
  }
})

test('server: SIGTERM exits cleanly within 5s', async () => {
  const handle = await startServer({ port: 0 })
  const start = Date.now()
  const code = await killServer(handle, 'SIGTERM')
  const elapsed = Date.now() - start
  assert.equal(code, 0, `exit code must be 0, got ${code}`)
  assert.ok(elapsed < 5500, `must exit within 5s, took ${elapsed}ms`)
})

test('server: SIGINT exits cleanly within 5s', async () => {
  const handle = await startServer({ port: 0 })
  const start = Date.now()
  const code = await killServer(handle, 'SIGINT')
  const elapsed = Date.now() - start
  assert.equal(code, 0, `exit code must be 0, got ${code}`)
  assert.ok(elapsed < 5500, `must exit within 5s, took ${elapsed}ms`)
})

test('server: unknown path returns structured 404 with details', async () => {
  const handle = await startServer({ port: 0 })
  try {
    const r = await fetchPath(handle.port, '/api/does-not-exist')
    assert.equal(r.status, 404)
    assert.ok(r.headers.get('content-type')?.includes('application/json'))
    assert.equal(r.body.error?.code, 'NOT_FOUND')
    assert.equal(typeof r.body.error?.message, 'string')
    assert.equal(typeof r.body.error?.ts, 'number')
    // Locked spec §2.6: error.details is part of the contract
    assert.ok(r.body.error?.details, 'error.details must be present per spec §2.6')
    assert.equal(r.body.error.details.path, '/api/does-not-exist')
    assert.equal(r.body.error.details.method, 'GET')
  } finally { await killServer(handle) }
})
