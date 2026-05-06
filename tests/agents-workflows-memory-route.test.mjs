/**
 * HTTP integration tests for the new kb domains: agents, workflows, memory.
 * Mirrors the bootHttp pattern from skills-route.test.mjs.
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

async function bootHttp() {
  _resetWiringForTests()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-domains-'))
  const skillsDir = path.join(root, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  const bus = new ChatEventBus()
  const kbBus = new KbEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
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
    port, server, root, skillsDir,
    async stop() {
      await new Promise((r) => server.close(() => r()))
      _resetWiringForTests()
    },
  }
}

async function jf(port, p, init = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, init)
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: r.status, body }
}

function seedSkill(skillsDir, name) {
  const dir = path.join(skillsDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`)
}

/* ============================== AGENTS ============================== */

test('agents: POST creates → GET reads → list contains it', async () => {
  const ctx = await bootHttp()
  try {
    seedSkill(ctx.skillsDir, 'reboot-server')
    seedSkill(ctx.skillsDir, 'patch-vm')

    const create = await jf(ctx.port, '/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'oncall-helper',
        description: 'On-call triage agent',
        skills: ['reboot-server', 'patch-vm'],
        persona: 'Calm under pressure.',
      }),
    })
    assert.equal(create.status, 201)
    assert.equal(create.body.name, 'oncall-helper')

    const read = await jf(ctx.port, '/api/agents/oncall-helper')
    assert.equal(read.status, 200)
    assert.deepStrictEqual(read.body.frontmatter.skills, ['reboot-server', 'patch-vm'])
    assert.equal(read.body.frontmatter.description, 'On-call triage agent')

    const list = await jf(ctx.port, '/api/agents')
    assert.equal(list.status, 200)
    assert.equal(list.body.agents.length, 1)
    assert.equal(list.body.agents[0].name, 'oncall-helper')
  } finally {
    await ctx.stop()
  }
})

test('agents: POST with unknown skill → 400 INVALID_AGENT_SKILLS with details.missing', async () => {
  const ctx = await bootHttp()
  try {
    seedSkill(ctx.skillsDir, 'reboot-server')
    const r = await jf(ctx.port, '/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'broken',
        skills: ['reboot-server', 'does-not-exist'],
      }),
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'INVALID_AGENT_SKILLS')
    assert.deepStrictEqual(r.body.error.details.missing, ['does-not-exist'])
  } finally {
    await ctx.stop()
  }
})

test('agents: POST same name twice → 409 AGENT_EXISTS', async () => {
  const ctx = await bootHttp()
  try {
    seedSkill(ctx.skillsDir, 's1')
    const body = JSON.stringify({ name: 'dup', skills: ['s1'] })
    const a = await jf(ctx.port, '/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    assert.equal(a.status, 201)
    const b = await jf(ctx.port, '/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
    assert.equal(b.status, 409)
    assert.equal(b.body.error.code, 'AGENT_EXISTS')
  } finally {
    await ctx.stop()
  }
})

test('agents: PUT updates description, GET 404 for unknown agent', async () => {
  const ctx = await bootHttp()
  try {
    seedSkill(ctx.skillsDir, 's1')
    await jf(ctx.port, '/api/agents', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a1', description: 'old', skills: ['s1'] }),
    })
    const upd = await jf(ctx.port, '/api/agents/a1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'new' }),
    })
    assert.equal(upd.status, 200)
    const read = await jf(ctx.port, '/api/agents/a1')
    assert.equal(read.body.frontmatter.description, 'new')

    const miss = await jf(ctx.port, '/api/agents/nope')
    assert.equal(miss.status, 404)
    assert.equal(miss.body.error.code, 'UNKNOWN_AGENT')
  } finally {
    await ctx.stop()
  }
})

/* ============================== WORKFLOWS ============================== */

test('workflows: POST creates with steps, GET reads back decoded steps', async () => {
  const ctx = await bootHttp()
  try {
    seedSkill(ctx.skillsDir, 'check-server-health')
    seedSkill(ctx.skillsDir, 'reboot-server')
    const r = await jf(ctx.port, '/api/workflows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'safe-reboot',
        description: 'Health-check, then reboot',
        steps: [
          { kind: 'skill', ref: 'check-server-health' },
          { kind: 'skill', ref: 'reboot-server' },
        ],
      }),
    })
    assert.equal(r.status, 201)

    const read = await jf(ctx.port, '/api/workflows/safe-reboot')
    assert.equal(read.status, 200)
    // Persisted as encoded strings; route returns frontmatter as-is.
    assert.deepStrictEqual(read.body.frontmatter.steps, ['skill:check-server-health', 'skill:reboot-server'])

    const list = await jf(ctx.port, '/api/workflows')
    assert.equal(list.status, 200)
    assert.equal(list.body.workflows[0].name, 'safe-reboot')
    assert.deepStrictEqual(list.body.workflows[0].steps, [
      { kind: 'skill', ref: 'check-server-health' },
      { kind: 'skill', ref: 'reboot-server' },
    ])
  } finally {
    await ctx.stop()
  }
})

test('workflows: POST with unknown skill ref → 400 INVALID_WORKFLOW_STEPS with details', async () => {
  const ctx = await bootHttp()
  try {
    seedSkill(ctx.skillsDir, 'ok-skill')
    const r = await jf(ctx.port, '/api/workflows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'bad-flow',
        steps: [
          { kind: 'skill', ref: 'ok-skill' },
          { kind: 'skill', ref: 'missing-skill' },
        ],
      }),
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'INVALID_WORKFLOW_STEPS')
    assert.ok(Array.isArray(r.body.error.details?.missing))
  } finally {
    await ctx.stop()
  }
})

test('workflows: PUT updates steps; UNKNOWN_WORKFLOW on missing', async () => {
  const ctx = await bootHttp()
  try {
    seedSkill(ctx.skillsDir, 's1')
    seedSkill(ctx.skillsDir, 's2')
    await jf(ctx.port, '/api/workflows', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'wf', steps: [{ kind: 'skill', ref: 's1' }] }),
    })
    const upd = await jf(ctx.port, '/api/workflows/wf', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: [{ kind: 'skill', ref: 's2' }] }),
    })
    assert.equal(upd.status, 200)
    const read = await jf(ctx.port, '/api/workflows/wf')
    assert.deepStrictEqual(read.body.frontmatter.steps, ['skill:s2'])

    const miss = await jf(ctx.port, '/api/workflows/nope', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: [{ kind: 'skill', ref: 's1' }] }),
    })
    assert.equal(miss.status, 404)
    assert.equal(miss.body.error.code, 'UNKNOWN_WORKFLOW')
  } finally {
    await ctx.stop()
  }
})

/* ============================== MEMORY ============================== */

test('memory: PUT upsert (creates then overwrites), GET reads', async () => {
  const ctx = await bootHttp()
  try {
    const a = await jf(ctx.port, '/api/memory/notes', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'first draft' }),
    })
    assert.equal(a.status, 200)

    const b = await jf(ctx.port, '/api/memory/notes', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'second draft' }),
    })
    assert.equal(b.status, 200)

    const read = await jf(ctx.port, '/api/memory/notes')
    assert.equal(read.status, 200)
    assert.equal(read.body.body, 'second draft')

    const list = await jf(ctx.port, '/api/memory')
    assert.equal(list.status, 200)
    assert.equal(list.body.entries.length, 1)
    assert.equal(list.body.entries[0].name, 'notes')
  } finally {
    await ctx.stop()
  }
})

test('memory: GET unknown → 404 UNKNOWN_MEMORY; bad name → 400', async () => {
  const ctx = await bootHttp()
  try {
    const miss = await jf(ctx.port, '/api/memory/nope')
    assert.equal(miss.status, 404)
    assert.equal(miss.body.error.code, 'UNKNOWN_MEMORY')

    const bad = await jf(ctx.port, '/api/memory/..%2Fevil')
    assert.equal(bad.status, 400)
  } finally {
    await ctx.stop()
  }
})

test('memory: PUT > 64 KB → 400 BODY_TOO_LARGE', async () => {
  const ctx = await bootHttp()
  try {
    const huge = 'x'.repeat(65_537)
    const r = await jf(ctx.port, '/api/memory/big', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: huge }),
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.error.code, 'BODY_TOO_LARGE')
  } finally {
    await ctx.stop()
  }
})
