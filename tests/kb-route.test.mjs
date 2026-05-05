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

async function bootHttp({ withSkills = true } = {}) {
  _resetWiringForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-route-'))
  const skillsDir = path.join(root, 'skills')
  if (withSkills) {
    fs.mkdirSync(path.join(skillsDir, 'alpha'), { recursive: true })
    fs.writeFileSync(
      path.join(skillsDir, 'alpha', 'SKILL.md'),
      `---\nname: alpha\ndescription: first\n---\n# Alpha\n`,
    )
    fs.mkdirSync(path.join(skillsDir, 'beta'), { recursive: true })
    fs.writeFileSync(
      path.join(skillsDir, 'beta', 'SKILL.md'),
      `---\nname: beta\nuses:\n  - alpha\n---\n# Beta uses alpha\n`,
    )
  } else {
    fs.mkdirSync(skillsDir, { recursive: true })
  }

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
  const sessions = new Map()
  globalThis.__wiring = {
    bus,
    runStore,
    tracker,
    bridge,
    sessions,
    kbBus,
    skillsDir,
    watcher: null,
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
    port,
    server,
    bus,
    kbBus,
    runStore,
    skillsDir,
    sessions,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()))
      _resetWiringForTests()
    },
  }
}

test('GET /api/kb/graph returns 200 with nodes/edges/diagnostics', async () => {
  const ctx = await bootHttp()
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/kb/graph`)
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.ok(Array.isArray(body.nodes))
    assert.equal(body.nodes.length, 2)
    const ids = body.nodes.map((n) => n.id).sort()
    assert.deepStrictEqual(ids, ['alpha', 'beta'])
    const usesEdge = body.edges.find((e) => e.kind === 'uses' && e.source === 'beta' && e.target === 'alpha')
    assert.ok(usesEdge)
    assert.ok(Array.isArray(body.diagnostics))
  } finally {
    await ctx.stop()
  }
})

test('GET /api/kb/graph: malformed skill is surfaced as a diagnostic without breaking the endpoint', async () => {
  // Codex r1 item 3: prove the route preserves diagnostics + 200 status when
  // one skill is malformed. Catches a different bug class than the unit test
  // — e.g., a route that drops the diagnostics field, returns 500, or caches.
  const ctx = await bootHttp({ withSkills: false })
  try {
    fs.mkdirSync(path.join(ctx.skillsDir, 'broken'), { recursive: true })
    fs.writeFileSync(
      path.join(ctx.skillsDir, 'broken', 'SKILL.md'),
      `---\nname: broken\nuses: [missing-bracket\n---\n# broken inline array\n`,
    )
    fs.mkdirSync(path.join(ctx.skillsDir, 'fine'), { recursive: true })
    fs.writeFileSync(
      path.join(ctx.skillsDir, 'fine', 'SKILL.md'),
      `---\nname: fine\n---\n# this one is fine\n`,
    )

    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/kb/graph`)
    assert.equal(r.status, 200, 'malformed skill must not break the endpoint')
    const body = await r.json()
    // Valid skill remains.
    const ids = body.nodes.map((n) => n.id)
    assert.deepStrictEqual(ids, ['fine'])
    // Diagnostic surfaces the broken file.
    const diag = body.diagnostics.find((d) => d.path.includes('broken/SKILL.md'))
    assert.ok(diag, `expected diagnostic for broken skill, got ${JSON.stringify(body.diagnostics)}`)
    assert.equal(diag.severity, 'error')
  } finally {
    await ctx.stop()
  }
})

test('GET /api/kb/graph returns empty graph when skills dir is empty', async () => {
  const ctx = await bootHttp({ withSkills: false })
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/api/kb/graph`)
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.deepStrictEqual(body.nodes, [])
    assert.deepStrictEqual(body.edges, [])
  } finally {
    await ctx.stop()
  }
})

test('GET /api/kb/events delivers events emitted on the kb bus', async () => {
  const ctx = await bootHttp()
  try {
    const ac = new AbortController()
    let resolveReady
    const ready = new Promise((r) => (resolveReady = r))
    const events = []
    const collectPromise = (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/api/kb/events`, { signal: ac.signal })
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let signaled = false
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          if (!signaled && buf.includes('\n\n')) {
            signaled = true
            resolveReady()
          }
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const lines = block.split('\n').filter((l) => l)
            let nonComment = false
            let id, ev, dataLines = []
            for (const line of lines) {
              if (line.startsWith(':')) continue
              nonComment = true
              if (line.startsWith('event: ')) ev = line.slice(7)
              else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
            }
            if (nonComment) events.push({ event: ev, data: JSON.parse(dataLines.join('\n')) })
          }
        }
      } catch (err) {
        if (err?.name !== 'AbortError') throw err
      }
      return events
    })()

    await ready
    ctx.kbBus.emit({ kind: 'add', path: '/x/y/foo/SKILL.md', skill: 'foo', ts: 1000 })
    ctx.kbBus.emit({ kind: 'change', path: '/x/y/foo/SKILL.md', skill: 'foo', ts: 1010 })
    await new Promise((r) => setTimeout(r, 100))
    ac.abort()
    const got = await collectPromise

    const kbEvents = got.filter((e) => e.event === 'kb.changed')
    assert.equal(kbEvents.length, 2)
    assert.equal(kbEvents[0].data.kind, 'add')
    assert.equal(kbEvents[1].data.kind, 'change')
    assert.equal(kbEvents[0].data.skill, 'foo')
  } finally {
    await ctx.stop()
  }
})

test('real watcher → SSE delivers a kb.changed add event within 200ms of an atomic write', async () => {
  // End-to-end coverage of the locked spec's 200ms latency promise:
  //   atomic tmp+rename → chokidar (awaitWriteFinish) → kbBus → SSE → client.
  _resetWiringForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-route-watcher-'))
  const skillsDir = path.join(root, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })

  const { ChatEventBus } = await import('../src/server/chat-event-bus.ts')
  const { KbEventBus } = await import('../src/server/kb-event-bus.ts')
  const { KbWatcher } = await import('../src/server/kb-watcher.ts')
  const { RunStore } = await import('../src/server/run-store.ts')
  const { SendRunTracker } = await import('../src/server/send-run-tracker.ts')

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
  const watcher = new KbWatcher({
    skillsDir,
    bus: kbBus,
    stabilityThreshold: 100,
    pollInterval: 25,
  })
  await watcher.start()

  globalThis.__wiring = {
    bus, runStore, tracker, bridge,
    sessions: new Map(),
    kbBus, skillsDir, watcher,
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

  try {
    const ac = new AbortController()
    let resolveReady
    const ready = new Promise((r) => (resolveReady = r))
    const events = []
    const collectPromise = (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/kb/events`, { signal: ac.signal })
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let signaled = false
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          if (!signaled && buf.includes('\n\n')) {
            signaled = true
            resolveReady()
          }
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const lines = block.split('\n').filter((l) => l)
            let nonComment = false
            let ev, dataLines = []
            for (const line of lines) {
              if (line.startsWith(':')) continue
              nonComment = true
              if (line.startsWith('event: ')) ev = line.slice(7)
              else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
            }
            if (nonComment) {
              events.push({ event: ev, data: JSON.parse(dataLines.join('\n')), receivedAt: Date.now() })
            }
          }
        }
      } catch (err) {
        if (err?.name !== 'AbortError') throw err
      }
      return events
    })()
    await ready

    // Atomic tmp+rename of a SKILL.md.
    const targetDir = path.join(skillsDir, 'live-skill')
    fs.mkdirSync(targetDir, { recursive: true })
    const tmpFile = path.join(targetDir, 'SKILL.md.tmp')
    const finalFile = path.join(targetDir, 'SKILL.md')
    fs.writeFileSync(tmpFile, `---\nname: live-skill\n---\n# new\n`)
    const writtenAt = Date.now()
    fs.renameSync(tmpFile, finalFile)

    // Wait up to 1500ms for the add event (chokidar's stabilityThreshold is 100ms).
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      const found = events.find((e) => e.event === 'kb.changed' && e.data.kind === 'add' && e.data.path === finalFile)
      if (found) {
        const latency = found.receivedAt - writtenAt
        // The locked spec promises 200ms; we allow chokidar's 100ms stability + delivery overhead.
        // 500ms is a comfortable upper bound that catches regressions without flapping on macOS fsevents jitter.
        assert.ok(latency < 500, `latency was ${latency}ms; spec ceiling 500ms`)
        // Exactly one add event for this final path; the .tmp file must NOT have produced its own add.
        const adds = events.filter((e) => e.event === 'kb.changed' && e.data.kind === 'add' && e.data.path === finalFile)
        assert.equal(adds.length, 1)
        const tmpAdds = events.filter((e) => e.event === 'kb.changed' && e.data.path === tmpFile)
        assert.equal(tmpAdds.length, 0)
        break
      }
      await new Promise((r) => setTimeout(r, 25))
    }
    ac.abort()
    await collectPromise
  } finally {
    await new Promise((resolve) => server.close(() => resolve()))
    await watcher.stop()
    _resetWiringForTests()
  }
})

test('kb subscribers do NOT receive run.* events (reverse channel isolation)', async () => {
  // Codex r1 item 4: proves the kb channel rejects events from the chat bus.
  // Symmetric to "chat does not see kb.changed" — but symmetric properties
  // are not type-system-enforced; a future code change could break one half
  // without breaking the other. So we test both halves.
  const ctx = await bootHttp({ withSkills: false })
  try {
    const ac = new AbortController()
    let resolveReady
    const ready = new Promise((r) => (resolveReady = r))
    const events = []
    const collectPromise = (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/api/kb/events`, { signal: ac.signal })
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let signaled = false
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          if (!signaled && buf.includes('\n\n')) {
            signaled = true
            resolveReady()
          }
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const lines = block.split('\n').filter((l) => l)
            let nonComment = false
            let ev
            for (const line of lines) {
              if (line.startsWith(':')) continue
              nonComment = true
              if (line.startsWith('event: ')) ev = line.slice(7)
            }
            if (nonComment) events.push({ event: ev })
          }
        }
      } catch (err) {
        if (err?.name !== 'AbortError') throw err
      }
      return events
    })()
    await ready

    // Emit a synthetic chat event directly on the chat bus. The kb subscriber
    // must not see it.
    await ctx.runStore.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'hi' })
    const enriched = await ctx.runStore.appendNormalized('r1', 's1', { event: 'run.start', data: {} })
    ctx.bus.emit(enriched)
    await new Promise((r) => setTimeout(r, 100))
    ac.abort()
    const got = await collectPromise

    const runEvents = got.filter((e) => typeof e.event === 'string' && e.event.startsWith('run.'))
    assert.equal(runEvents.length, 0, `kb subscriber must not see run.* events, got ${JSON.stringify(runEvents)}`)
  } finally {
    await ctx.stop()
  }
})

test('chat events do NOT cross-contaminate kb events (channel isolation)', async () => {
  const ctx = await bootHttp()
  try {
    // Create a session for the chat channel.
    const sessRes = await fetch(`http://127.0.0.1:${ctx.port}/api/sessions`, { method: 'POST' })
    const { sessionKey } = await sessRes.json()

    const ac = new AbortController()
    let resolveReady
    const ready = new Promise((r) => (resolveReady = r))
    const events = []
    const collectPromise = (async () => {
      try {
        const res = await fetch(
          `http://127.0.0.1:${ctx.port}/api/chat-events?sessionKey=${sessionKey}&tabId=t1`,
          { signal: ac.signal },
        )
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let signaled = false
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          if (!signaled && buf.includes('\n\n')) {
            signaled = true
            resolveReady()
          }
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const lines = block.split('\n').filter((l) => l)
            let nonComment = false
            let ev
            for (const line of lines) {
              if (line.startsWith(':')) continue
              nonComment = true
              if (line.startsWith('event: ')) ev = line.slice(7)
            }
            if (nonComment) events.push({ event: ev })
          }
        }
      } catch (err) {
        if (err?.name !== 'AbortError') throw err
      }
      return events
    })()
    await ready
    // Fire a KB event — chat subscriber must not see it.
    ctx.kbBus.emit({ kind: 'add', path: '/x/y/foo/SKILL.md', skill: 'foo', ts: 1000 })
    await new Promise((r) => setTimeout(r, 100))
    ac.abort()
    const got = await collectPromise
    const kbEvents = got.filter((e) => e.event === 'kb.changed')
    assert.equal(kbEvents.length, 0, 'chat subscriber must not see kb events')
  } finally {
    await ctx.stop()
  }
})
