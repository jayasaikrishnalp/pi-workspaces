/**
 * Auth + middleware tests with auth ENABLED. The other test files set
 * PI_WORKSPACE_AUTH_DISABLED=1 globally; here we override per-test.
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
import { AuthStore } from '../src/server/auth-store.ts'

async function bootHttp({ devToken } = {}) {
  _resetWiringForTests()
  // Force auth on for these tests; restore in teardown.
  delete process.env.PI_WORKSPACE_AUTH_DISABLED
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-route-'))
  const skillsDir = path.join(root, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  const tokenPath = path.join(root, 'dev-token.txt')
  if (devToken !== undefined) {
    fs.writeFileSync(tokenPath, devToken + '\n', { mode: 0o600 })
  }

  const bus = new ChatEventBus()
  const kbBus = new KbEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
  const authStore = new AuthStore({ workspaceRoot: root })
  await authStore.load()
  const bridge = {
    send: async () => {}, waitForActiveCompletion: async () => {}, abort: async () => {}, shutdown: async () => {},
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
    confluence: null, confluenceConfigured: false,
    authStore, workspaceRoot: root,
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
    port, server, authStore, root,
    async stop() {
      await new Promise((r) => server.close(() => r()))
      _resetWiringForTests()
      // Restore the global "auth disabled in tests" flag.
      process.env.PI_WORKSPACE_AUTH_DISABLED = '1'
    },
  }
}

test('GET /api/health is public — no cookie required', async () => {
  const ctx = await bootHttp({ devToken: 'TEST' })
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/health`)
    assert.equal(r.status, 200)
  } finally {
    await ctx.stop()
  }
})

test('Protected route without cookie returns 401 AUTH_REQUIRED', async () => {
  const ctx = await bootHttp({ devToken: 'TEST' })
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/sessions`)
    assert.equal(r.status, 401)
    const body = await r.json()
    assert.equal(body.error.code, 'AUTH_REQUIRED')
  } finally {
    await ctx.stop()
  }
})

test('POST /api/auth/login with correct token sets a cookie', async () => {
  const ctx = await bootHttp({ devToken: 'TEST' })
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'TEST' }),
    })
    assert.equal(r.status, 200)
    const setCookie = r.headers.get('set-cookie')
    assert.match(setCookie, /workspace_session=/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Lax/)
  } finally {
    await ctx.stop()
  }
})

test('POST /api/auth/login with wrong token returns 401 and NO cookie', async () => {
  const ctx = await bootHttp({ devToken: 'TEST' })
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'WRONG' }),
    })
    assert.equal(r.status, 401)
    assert.equal(r.headers.get('set-cookie'), null)
  } finally {
    await ctx.stop()
  }
})

test('login → check → logout → check round-trip', async () => {
  const ctx = await bootHttp({ devToken: 'TEST' })
  try {
    const login = await fetch(`http://127.0.0.1:${ctx.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'TEST' }),
    })
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const check1 = await fetch(`http://127.0.0.1:${ctx.port}/api/auth/check`, { headers: { Cookie: cookie } })
    assert.equal(check1.status, 200)

    const logout = await fetch(`http://127.0.0.1:${ctx.port}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    assert.equal(logout.status, 200)

    const check2 = await fetch(`http://127.0.0.1:${ctx.port}/api/auth/check`, { headers: { Cookie: cookie } })
    assert.equal(check2.status, 401)
  } finally {
    await ctx.stop()
  }
})

test('cookie persists across new AuthStore instance reading sessions.json', async () => {
  const ctx = await bootHttp({ devToken: 'TEST' })
  try {
    const login = await fetch(`http://127.0.0.1:${ctx.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'TEST' }),
    })
    const cookieFull = login.headers.get('set-cookie').split(';')[0]
    const sessionId = cookieFull.split('=')[1]

    // Create a NEW AuthStore against the same root and verify it sees the
    // session — that's what survives a server restart.
    const fresh = new AuthStore({ workspaceRoot: ctx.root })
    await fresh.load()
    assert.ok(fresh.hasSession(sessionId), 'fresh AuthStore should load existing session')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/probe is cookie-gated — 401 without cookie', async () => {
  const ctx = await bootHttp({ devToken: 'TEST' })
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/probe`)
    assert.equal(r.status, 401)
  } finally {
    await ctx.stop()
  }
})

test('GET /api/probe with cookie returns capability matrix', async () => {
  const ctx = await bootHttp({ devToken: 'TEST' })
  try {
    const login = await fetch(`http://127.0.0.1:${ctx.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'TEST' }),
    })
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/probe`, { headers: { Cookie: cookie } })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(typeof body.pi.ok, 'boolean')
    assert.equal(typeof body.confluence.configured, 'boolean')
    assert.equal(typeof body.skills.count, 'number')
    assert.equal(typeof body.auth.piAuthJsonPresent, 'boolean')
    assert.equal(typeof body.workspace.skillsDir, 'string')
    assert.equal(typeof body.workspace.runsDir, 'string')
  } finally {
    await ctx.stop()
  }
})

test('x-workspace-internal-token header bypasses cookie auth', async () => {
  const { setInternalToken } = await import('../src/server/auth-middleware.ts')
  const TOKEN = 'tk-' + 'a'.repeat(60)
  setInternalToken(TOKEN)
  try {
    const ctx = await bootHttp({ devToken: 'TEST' })
    try {
      // No cookie, but with the internal token header → allowed.
      const r = await fetch(`http://127.0.0.1:${ctx.port}/api/sessions`, {
        headers: { 'x-workspace-internal-token': TOKEN },
      })
      assert.notEqual(r.status, 401, 'request with valid internal token must NOT 401')
    } finally { await ctx.stop() }
  } finally { setInternalToken(null) }
})

test('x-workspace-internal-token with wrong value still 401s', async () => {
  const { setInternalToken } = await import('../src/server/auth-middleware.ts')
  const TOKEN = 'tk-' + 'b'.repeat(60)
  setInternalToken(TOKEN)
  try {
    const ctx = await bootHttp({ devToken: 'TEST' })
    try {
      const r = await fetch(`http://127.0.0.1:${ctx.port}/api/sessions`, {
        headers: { 'x-workspace-internal-token': 'wrong-value' },
      })
      assert.equal(r.status, 401)
    } finally { await ctx.stop() }
  } finally { setInternalToken(null) }
})
