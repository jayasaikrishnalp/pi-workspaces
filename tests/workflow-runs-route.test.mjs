/**
 * HTTP integration test for the new /api/workflow-runs/* family.
 *
 * Drives the runner with the SimulatedAgentExecutor (no pi). Asserts:
 *   - POST /api/workflow-runs with valid body → 202 { runId }
 *   - GET  /api/workflow-runs/:runId/events → SSE replays full lifecycle
 *   - GET  /api/workflow-runs/:runId       → run + steps populated
 *   - POST /api/workflow-runs returns 400 on missing/extra-validation issues
 *   - POST /api/workflow-runs returns 409 when an active run exists for the
 *     same workflow id (use a slow blocking executor to make the window)
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
import { openDb } from '../src/server/db.ts'
import { WorkflowRunsStore } from '../src/server/workflow-runs-store.ts'
import { WorkflowRunBusRegistry } from '../src/server/workflow-run-bus.ts'
import { WorkflowRunner, SimulatedAgentExecutor } from '../src/server/workflow-runner.ts'

async function bootHttp({ executor } = {}) {
  _resetWiringForTests()
  process.env.PI_WORKSPACE_AUTH_DISABLED = '1'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-runs-route-'))
  const db = openDb(path.join(root, 'data.sqlite'))
  const bus = new ChatEventBus()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const tracker = new SendRunTracker()
  const bridge = { send: async () => {}, waitForActiveCompletion: async () => {}, abort: async () => {}, shutdown: async () => {} }
  const sessions = new Map()
  const workflowRunsStore = new WorkflowRunsStore(db)
  const workflowRunBuses = new WorkflowRunBusRegistry()
  const workflowRunner = new WorkflowRunner({
    store: workflowRunsStore,
    bus: workflowRunBuses,
    executor: executor ?? new SimulatedAgentExecutor(),
  })
  globalThis.__wiring = {
    bus, runStore, tracker, bridge, sessions, db,
    workflowRunsStore, workflowRunBuses, workflowRunner,
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
    port, server,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()))
      _resetWiringForTests()
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

const SAMPLE_AGENT = {
  id: 'jira-agent', name: 'Jira Agent', kind: 'router',
  role: 'pulls tickets', model: 'claude-haiku-4-5',
  skills: ['jira.fetch'], prompt: 'You are jira agent.',
}

const SAMPLE_AGENT_2 = {
  id: 'reviewer', name: 'Reviewer', kind: 'reviewer',
  role: 'reviews', model: 'claude-sonnet-4-5',
  skills: [], prompt: 'You review.',
}

const SAMPLE_WF = {
  id: 'wf-test',
  name: 'Test',
  task: 'unit',
  steps: [
    { id: 'fetch', agentId: 'jira-agent', note: 'pull ticket' },
    { id: 'review', agentId: 'reviewer', note: 'sign off', branches: { ok: 'end' } },
  ],
}

async function postStart(port, body) {
  return fetchJson(port, '/api/workflow-runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('POST /api/workflow-runs with valid body → 202 { runId } and run completes', async () => {
  const ctx = await bootHttp()
  try {
    const r = await postStart(ctx.port, { workflow: SAMPLE_WF, agents: [SAMPLE_AGENT, SAMPLE_AGENT_2] })
    assert.equal(r.status, 202)
    assert.ok(r.body.runId)
    // wait for run.end via polling the detail endpoint.
    let detail
    for (let i = 0; i < 100; i++) {
      detail = await fetchJson(ctx.port, `/api/workflow-runs/${r.body.runId}`)
      if (detail.body?.run?.status === 'completed') break
      await new Promise((res) => setTimeout(res, 20))
    }
    assert.equal(detail.body.run.status, 'completed')
    assert.equal(detail.body.steps.length, 2)
    assert.equal(detail.body.steps[0].status, 'completed')
    assert.equal(detail.body.steps[1].step_decision, 'ok')
    assert.equal(detail.body.steps[1].step_next, 'end')
  } finally { await ctx.stop() }
})

test('GET /api/workflow-runs/:runId/events streams the full lifecycle', async () => {
  const ctx = await bootHttp()
  try {
    const r = await postStart(ctx.port, { workflow: SAMPLE_WF, agents: [SAMPLE_AGENT, SAMPLE_AGENT_2] })
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/workflow-runs/${r.body.runId}/events`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let acc = ''
    let runEnd = false
    while (!runEnd) {
      const { value, done } = await reader.read()
      if (done) break
      acc += dec.decode(value, { stream: true })
      if (/event: run\.end/.test(acc)) runEnd = true
    }
    await reader.cancel().catch(() => {})
    const eventNames = (acc.match(/event: ([\w.]+)/g) || []).map((s) => s.replace('event: ', ''))
    assert.ok(eventNames.includes('run.start'))
    assert.ok(eventNames.includes('step.start'))
    assert.ok(eventNames.includes('step.end'))
    assert.ok(eventNames.includes('run.end'))
  } finally { await ctx.stop() }
})

test('POST /api/workflow-runs returns 400 on missing workflow or agents', async () => {
  const ctx = await bootHttp()
  try {
    let r = await postStart(ctx.port, { agents: [] })
    assert.equal(r.status, 400)
    r = await postStart(ctx.port, { workflow: SAMPLE_WF })
    assert.equal(r.status, 400)
    // step references unknown agent
    const bad = { ...SAMPLE_WF, steps: [{ id: 's', agentId: 'ghost' }] }
    r = await postStart(ctx.port, { workflow: bad, agents: [SAMPLE_AGENT] })
    assert.equal(r.status, 400)
  } finally { await ctx.stop() }
})

test('POST /api/workflow-runs returns 409 when same workflow id is already running', async () => {
  // Slow executor so the first run is still running when the second start fires.
  class BlockingExecutor {
    async execute(_ctx, hooks) {
      hooks.emitChunk('starting\n')
      await new Promise((r) => setTimeout(r, 250))
      return { status: 'completed', output: 'starting\n' }
    }
  }
  const ctx = await bootHttp({ executor: new BlockingExecutor() })
  try {
    const r1 = await postStart(ctx.port, { workflow: SAMPLE_WF, agents: [SAMPLE_AGENT, SAMPLE_AGENT_2] })
    assert.equal(r1.status, 202)
    const r2 = await postStart(ctx.port, { workflow: SAMPLE_WF, agents: [SAMPLE_AGENT, SAMPLE_AGENT_2] })
    assert.equal(r2.status, 409)
    assert.equal(r2.body.error.code, 'ACTIVE_RUN')
    // Wait for the first run to finish so its async DB writes don't race the
    // server teardown.
    for (let i = 0; i < 200; i++) {
      const detail = await fetchJson(ctx.port, `/api/workflow-runs/${r1.body.runId}`)
      if (detail.body?.run?.status === 'completed' || detail.body?.run?.status === 'failed') break
      await new Promise((res) => setTimeout(res, 25))
    }
  } finally { await ctx.stop() }
})
