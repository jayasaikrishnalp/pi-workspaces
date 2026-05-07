/**
 * Integration test for the full workflow→pi-bridge plumbing.
 *
 * Uses a fake pi child that:
 *   - Records every prompt written to its stdin
 *   - Emits a deterministic event sequence for each prompt:
 *       response (success:true) → agent_start → message_start (assistant)
 *       → message_update text_delta × N → message_end → agent_end
 *
 * Asserts:
 *   - A 2-step workflow with branches drives pi twice (one prompt per step)
 *   - Each prompt is the composePrompt output (contains agent.prompt + step.note)
 *   - The DECISION token in step 1's emitted output is parsed and routed
 *     to the matching branch (step 2)
 *   - Workflow bus emits run.start → step.start → step.output × N → step.end
 *     (with decision + next) → run.start → ... → run.end
 *   - Step output is persisted in the SQLite store with decision + next
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { PiRpcBridge } from '../src/server/pi-rpc-bridge.ts'
import { ChatEventBus } from '../src/server/chat-event-bus.ts'
import { RunStore } from '../src/server/run-store.ts'
import { SendRunTracker } from '../src/server/send-run-tracker.ts'
import { openDb } from '../src/server/db.ts'
import { WorkflowRunsStore } from '../src/server/workflow-runs-store.ts'
import { WorkflowRunBusRegistry } from '../src/server/workflow-run-bus.ts'
import { WorkflowRunner } from '../src/server/workflow-runner.ts'
import { PiBridgeStepExecutor } from '../src/server/pi-bridge-step-executor.ts'

function makeFakeChild() {
  const ee = new EventEmitter()
  const linesIn = []
  let pendingPushJson
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        linesIn.push(line)
        // Auto-ack new_session RPCs the bridge emits between session keys.
        try {
          const o = JSON.parse(line)
          if (o && o.type === 'new_session') {
            // Defer until stdout exists.
            queueMicrotask(() => pendingPushJson?.({ id: o.id, type: 'response', command: 'new_session', success: true }))
          }
        } catch { /* ignore non-JSON */ }
      }
      cb()
    },
  })
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  pendingPushJson = (obj) => stdout.push(JSON.stringify(obj) + '\n')
  const fake = {
    pid: 99999,
    killed: false,
    stdin, stdout, stderr,
    on: (ev, fn) => ee.on(ev, fn),
    once: (ev, fn) => ee.once(ev, fn),
    off: (ev, fn) => ee.off(ev, fn),
    emit: (...args) => ee.emit(...args),
    kill: (signal) => { fake.killed = true; setImmediate(() => ee.emit('exit', null, signal ?? 'SIGTERM')); return true },
    linesIn,
    pushJson(obj) { stdout.push(JSON.stringify(obj) + '\n') },
  }
  return fake
}

/**
 * Drive the fake child as if pi were producing events for a prompt RPC.
 * `responseText` is split into roughly 3 deltas to verify streaming.
 */
function driveResponse(fake, runId, responseText) {
  fake.pushJson({ id: runId, type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  fake.pushJson({ type: 'turn_start' })
  fake.pushJson({ type: 'message_start', message: { role: 'assistant' } })
  // Stream the response in chunks via message_update + assistantMessageEvent text_delta.
  const chunkSize = Math.max(1, Math.ceil(responseText.length / 3))
  for (let i = 0; i < responseText.length; i += chunkSize) {
    const delta = responseText.slice(i, i + chunkSize)
    fake.pushJson({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta },
    })
  }
  fake.pushJson({ type: 'message_end', message: { role: 'assistant' } })
  fake.pushJson({ type: 'turn_end' })
  fake.pushJson({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'endTurn' }] })
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wf-replay-'))
}

const SAMPLE_AGENT_TRIAGE = {
  id: 'triage-agent', name: 'Triage', kind: 'router',
  role: 'r', model: 'claude-haiku-4-5',
  skills: [], prompt: 'You are the triage agent.',
}
const SAMPLE_AGENT_REVIEW = {
  id: 'review-agent', name: 'Reviewer', kind: 'reviewer',
  role: 'r', model: 'claude-sonnet-4-5',
  skills: [], prompt: 'You review.',
}

const SAMPLE_WF = {
  id: 'wf-replay',
  name: 'Replay Test',
  task: 'demo',
  steps: [
    { id: 'triage', agentId: 'triage-agent', note: 'pull info', branches: { ok: 'review', fail: 'end' } },
    { id: 'review', agentId: 'review-agent', note: 'sign off' },
  ],
}

test('full plumbing: pi events drive workflow bus events end-to-end', async () => {
  const root = tmpRoot()
  const db = openDb(path.join(root, 'data.sqlite'))
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const chatBus = new ChatEventBus()
  const tracker = new SendRunTracker()
  let fake
  const bridge = new PiRpcBridge({
    runStore, bus: chatBus, tracker,
    spawnPi: () => { fake = makeFakeChild(); return fake },
  })

  const workflowRunsStore = new WorkflowRunsStore(db)
  const workflowRunBuses = new WorkflowRunBusRegistry()
  const executor = new PiBridgeStepExecutor({ bridge, runStore, chatBus })
  const runner = new WorkflowRunner({ store: workflowRunsStore, bus: workflowRunBuses, executor })

  // Pre-create the bus before runner.start so we never miss events.
  // Buses are keyed by runId, but getOrCreate is idempotent — we'll re-fetch
  // after we know the id. Track run.end via a flag for poll loops.
  let runEnded = false
  const runId = await runner.start({
    workflow: SAMPLE_WF,
    agents: [SAMPLE_AGENT_TRIAGE, SAMPLE_AGENT_REVIEW],
  })
  const wfBus = workflowRunBuses.getOrCreate(runId)
  wfBus.subscribe((e) => { if (e.kind === 'run.end') runEnded = true })

  // Wait until pi spawns and the first prompt has been written.
  for (let i = 0; i < 100; i++) {
    if (fake?.linesIn.length > 0) break
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.ok(fake, 'pi spawned')

  // Step 1 prompt is on stdin. Find the prompt RPC line and verify shape.
  const firstPrompt = fake.linesIn.find((l) => { try { return JSON.parse(l).type === 'prompt' } catch { return false } })
  const parsed1 = JSON.parse(firstPrompt)
  assert.equal(parsed1.type, 'prompt')
  assert.match(parsed1.message, /You are the triage agent/)
  assert.match(parsed1.message, /STEP: triage/)
  assert.match(parsed1.message, /pull info/)
  assert.match(parsed1.message, /DECISION/) // branches present → trailer added
  const piRunId1 = parsed1.id

  // Drive step 1's response (with DECISION: ok) — this should land via chatBus
  // and the executor should resolve, then step 2 should fire.
  driveResponse(fake, piRunId1, 'analysis...\n\nDECISION: ok')

  // Wait for second prompt to land on stdin.
  for (let i = 0; i < 200; i++) {
    if (fake.linesIn.length > 1) break
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.ok(fake.linesIn.length > 1, 'second prompt sent')
  const promptRpcs = fake.linesIn
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter((o) => o && o.type === 'prompt')
  assert.equal(promptRpcs.length, 2)
  const parsed2 = promptRpcs[1]
  assert.match(parsed2.message, /You are Reviewer/)
  assert.match(parsed2.message, /STEP: review/)
  assert.match(parsed2.message, /PREVIOUS STEP OUTPUT:/)
  assert.match(parsed2.message, /DECISION: ok/) // tail of prev output preserved
  const piRunId2 = parsed2.id

  // Drive step 2 to completion.
  driveResponse(fake, piRunId2, 'approved.')

  // Wait for run.end on workflow bus.
  for (let i = 0; i < 200; i++) {
    if (runEnded) break
    await new Promise((r) => setTimeout(r, 10))
  }
  // Read full history (chronological).
  const wfEvents = wfBus.history()
  const runEnd = wfEvents.find((e) => e.kind === 'run.end')
  assert.ok(runEnd, 'run.end emitted')
  assert.equal(runEnd.status, 'completed')

  // Verify lifecycle structure.
  const kinds = wfEvents.map((e) => e.kind)
  assert.ok(kinds.indexOf('run.start') < kinds.indexOf('step.start'))
  assert.equal(kinds.filter((k) => k === 'step.start').length, 2)
  assert.equal(kinds.filter((k) => k === 'step.end').length, 2)

  // step.end for triage must carry decision='ok' and next='review'.
  const triageEnd = wfEvents.find((e) => e.kind === 'step.end' && e.stepId === 'triage')
  assert.equal(triageEnd.decision, 'ok')
  assert.equal(triageEnd.next, 'review')
  assert.equal(triageEnd.status, 'completed')

  // SQLite persisted: step rows have decision/next + outputs.
  const steps = workflowRunsStore.listSteps(runId)
  assert.equal(steps.length, 2)
  assert.equal(steps[0].step_id, 'triage')
  assert.equal(steps[0].step_decision, 'ok')
  assert.equal(steps[0].step_next, 'review')
  assert.match(steps[0].output, /DECISION: ok/)
  assert.equal(steps[1].step_id, 'review')
  assert.equal(steps[1].status, 'completed')

  await bridge.shutdown()
})

test('pi error on step 1 halts the workflow with run.end status=failed', async () => {
  const root = tmpRoot()
  const db = openDb(path.join(root, 'data.sqlite'))
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const chatBus = new ChatEventBus()
  const tracker = new SendRunTracker()
  let fake
  const bridge = new PiRpcBridge({
    runStore, bus: chatBus, tracker,
    spawnPi: () => { fake = makeFakeChild(); return fake },
  })

  const workflowRunsStore = new WorkflowRunsStore(db)
  const workflowRunBuses = new WorkflowRunBusRegistry()
  const executor = new PiBridgeStepExecutor({ bridge, runStore, chatBus })
  const runner = new WorkflowRunner({ store: workflowRunsStore, bus: workflowRunBuses, executor })

  let runEnded = false
  const runId = await runner.start({ workflow: SAMPLE_WF, agents: [SAMPLE_AGENT_TRIAGE, SAMPLE_AGENT_REVIEW] })
  const wfBus = workflowRunBuses.getOrCreate(runId)
  wfBus.subscribe((e) => { if (e.kind === 'run.end') runEnded = true })

  for (let i = 0; i < 100; i++) {
    if (fake?.linesIn.length > 0) break
    await new Promise((r) => setTimeout(r, 10))
  }
  const promptLine = fake.linesIn.find((l) => { try { return JSON.parse(l).type === 'prompt' } catch { return false } })
  const piRunId1 = JSON.parse(promptLine).id
  // Pi reports the prompt RPC failed.
  fake.pushJson({ id: piRunId1, type: 'response', command: 'prompt', success: false, error: 'auth failed' })

  for (let i = 0; i < 200; i++) {
    if (runEnded) break
    await new Promise((r) => setTimeout(r, 10))
  }
  const wfEvents = wfBus.history()
  const runEnd = wfEvents.find((e) => e.kind === 'run.end')
  assert.equal(runEnd.status, 'failed')

  // Step 2 should NOT have started.
  const stepStarts = wfEvents.filter((e) => e.kind === 'step.start')
  assert.equal(stepStarts.length, 1)

  await bridge.shutdown()
})
