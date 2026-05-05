/**
 * Unit tests for pi-rpc-bridge using a fake pi child process. Covers:
 * - happy path: prompt → events → run.completed
 * - response success:false → terminalization
 * - malformed JSON → terminalization
 * - child crash → terminalization (with no double-write)
 * - BRIDGE_BUSY rejection
 *
 * No real pi process is spawned. Tests run in <1s on the laptop.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { Readable, Writable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

import { PiRpcBridge } from '../src/server/pi-rpc-bridge.ts'
import { ChatEventBus } from '../src/server/chat-event-bus.ts'
import { RunStore } from '../src/server/run-store.ts'
import { SendRunTracker } from '../src/server/send-run-tracker.ts'

/**
 * A tiny fake of the bits of ChildProcess our bridge actually uses:
 *   stdin: Writable (we capture every line written)
 *   stdout: Readable (push() to drive parsing)
 *   stderr: Readable (we don't drive it)
 *   on('exit'), on('error'): EventEmitter
 *   pid: a fake number
 *   killed: boolean
 *   kill(), exit(): test-only helpers
 */
function makeFakeChild() {
  const ee = new EventEmitter()
  const linesIn = []
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      // Lines are JSON commands ending in \n.
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      for (const line of text.split('\n')) {
        if (line.length > 0) linesIn.push(line)
      }
      cb()
    },
  })
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })

  const fake = {
    pid: 99999,
    killed: false,
    stdin,
    stdout,
    stderr,
    on: (ev, fn) => ee.on(ev, fn),
    once: (ev, fn) => ee.once(ev, fn),
    off: (ev, fn) => ee.off(ev, fn),
    emit: (...args) => ee.emit(...args),
    kill: (signal) => {
      fake.killed = true
      // Simulate normal exit on next tick.
      setImmediate(() => ee.emit('exit', null, signal ?? 'SIGTERM'))
      return true
    },

    // ---- test helpers
    linesIn,
    /** Push a JSON object as a stdout line. */
    pushJson(obj) {
      stdout.push(JSON.stringify(obj) + '\n')
    },
    /** Push raw text to stdout (for malformed-JSON tests). */
    pushRaw(text) {
      stdout.push(text)
    },
    /** Simulate child exit. */
    crash(code = 1, signal = null) {
      ee.emit('exit', code, signal)
    },
  }
  return fake
}

function tmpStoreRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'))
}

async function makeBridge() {
  const root = tmpStoreRoot()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const bus = new ChatEventBus()
  const tracker = new SendRunTracker()
  let fake
  const bridge = new PiRpcBridge({
    runStore,
    bus,
    tracker,
    spawnPi: () => {
      fake = makeFakeChild()
      return fake
    },
  })
  return {
    bridge,
    runStore,
    bus,
    tracker,
    root,
    getFake: () => fake,
  }
}

/** Resolves once a normalized event with the given name has been emitted. */
function waitForEvent(bus, eventName) {
  return new Promise((resolve) => {
    const unsub = bus.subscribe((e) => {
      if (e.event === eventName) {
        unsub()
        resolve(e)
      }
    })
  })
}

async function startRunOnDisk(runStore, runId, sessionKey, prompt) {
  return runStore.startRun({ runId, sessionKey, prompt })
}

// ---- happy path -------------------------------------------------------------

test('persist→casStatus→emit ordering: getStatus is already terminal when subscribers see run.completed', async () => {
  // Direct assertion of the disk-before-bus ordering for run.completed.
  const ctx = await makeBridge()
  const observations = []
  ctx.bus.subscribe(async (e) => {
    if (e.event === 'run.completed') {
      const status = await ctx.runStore.getStatus(e.meta.runId)
      observations.push({ status, eventStatus: e.data.status })
    }
  })

  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'hi')

  const completed = waitForEvent(ctx.bus, 'run.completed')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'hi' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  fake.pushJson({ type: 'agent_end', messages: [] })
  await completed
  // Allow the async observer subscriber to settle.
  await new Promise((r) => setImmediate(r))

  assert.equal(observations.length, 1, 'observer must have run exactly once')
  assert.equal(observations[0].status, 'success', 'getStatus must already be terminal when run.completed is emitted')
  assert.equal(observations[0].eventStatus, 'success')
})

test('persist→casStatus→emit ordering also holds for terminalize() error path', async () => {
  const ctx = await makeBridge()
  const observations = []
  ctx.bus.subscribe(async (e) => {
    if (e.event === 'run.completed') {
      const status = await ctx.runStore.getStatus(e.meta.runId)
      observations.push({ status, eventStatus: e.data.status })
    }
  })

  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'hi')

  const completed = waitForEvent(ctx.bus, 'run.completed')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'hi' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: false, error: 'no auth' })
  await completed
  await new Promise((r) => setImmediate(r))

  assert.equal(observations.length, 1)
  assert.equal(observations[0].status, 'error')
  assert.equal(observations[0].eventStatus, 'error')
})

test('crash-then-respawn: a fresh send after a crash spawns a new pi child', async () => {
  // Tracks how many times spawnPi is called via the deps factory.
  const root = tmpStoreRoot()
  const runStore = new RunStore({ root: path.join(root, 'runs') })
  const bus = new ChatEventBus()
  const tracker = new SendRunTracker()
  const fakes = []
  const bridge = new PiRpcBridge({
    runStore,
    bus,
    tracker,
    spawnPi: () => {
      const f = makeFakeChild()
      fakes.push(f)
      return f
    },
  })

  // Run 1: send, partial events, crash before completion.
  tracker.start('s1', 'r1')
  await runStore.startRun({ runId: 'r1', sessionKey: 's1', prompt: 'one' })
  const completed1 = waitForEvent(bus, 'run.completed')
  await bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'one' })
  assert.equal(fakes.length, 1, 'first send spawns one child')
  const f1 = fakes[0]
  f1.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  f1.pushJson({ type: 'agent_start' })
  // crash before run.completed
  f1.crash(137, 'SIGKILL')
  await completed1
  assert.equal(await runStore.getStatus('r1'), 'error')
  assert.equal(tracker.getActive('s1'), null)

  // Snapshot old child's stdin BEFORE the second send so any new write
  // landing on the old (dead) child would be detectable.
  const oldLineCount = f1.linesIn.length

  // Run 2: a fresh send must spawn a NEW child.
  tracker.start('s1', 'r2')
  await runStore.startRun({ runId: 'r2', sessionKey: 's1', prompt: 'two' })
  const completed2 = waitForEvent(bus, 'run.completed')
  await bridge.send({ sessionKey: 's1', runId: 'r2', prompt: 'two' })
  assert.equal(fakes.length, 2, 'second send spawns a fresh child')
  const f2 = fakes[1]
  assert.notEqual(f1, f2, 'distinct child object')
  // The new prompt must be on f2, not f1.
  assert.equal(f2.linesIn.length, 1)
  assert.equal(JSON.parse(f2.linesIn[0]).message, 'two')
  assert.equal(f1.linesIn.length, oldLineCount, 'old child must not receive new prompts')

  f2.pushJson({ id: 'r2', type: 'response', command: 'prompt', success: true })
  f2.pushJson({ type: 'agent_start' })
  f2.pushJson({ type: 'agent_end', messages: [] })
  await completed2
  assert.equal(await runStore.getStatus('r2'), 'success')
})

test('happy path: prompt sent, agent_start..agent_end produces a clean event sequence', async () => {
  const ctx = await makeBridge()
  const collected = []
  ctx.bus.subscribe((e) => collected.push(e))

  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'hi')

  const completed = waitForEvent(ctx.bus, 'run.completed')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'hi' })
  const fake = ctx.getFake()

  // Verify the bridge wrote the prompt to pi's stdin as a JSON line.
  await new Promise((r) => setImmediate(r))
  assert.equal(fake.linesIn.length, 1)
  const cmd = JSON.parse(fake.linesIn[0])
  assert.equal(cmd.type, 'prompt')
  assert.equal(cmd.message, 'hi')
  assert.equal(cmd.id, 'r1')

  // Drive the response then a minimal happy-path event sequence.
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  fake.pushJson({ type: 'turn_start' })
  fake.pushJson({ type: 'turn_end' })
  fake.pushJson({ type: 'agent_end', messages: [] })

  await completed

  const names = collected.map((e) => e.event)
  assert.deepStrictEqual(names, [
    'run.start',
    'turn.start',
    'turn.end',
    'run.completed',
  ])
  assert.equal(collected[3].data.status, 'success')

  // run-store status flipped, tracker cleared.
  assert.equal(await ctx.runStore.getStatus('r1'), 'success')
  assert.equal(ctx.tracker.getActive('s1'), null)
})

// ---- prompt rejection -------------------------------------------------------

test('response success:false terminalizes the run with pi.error + run.completed status:error', async () => {
  const ctx = await makeBridge()
  const collected = []
  ctx.bus.subscribe((e) => collected.push(e))

  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'hi')

  const completed = waitForEvent(ctx.bus, 'run.completed')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'hi' })
  const fake = ctx.getFake()

  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: false, error: 'auth missing' })

  await completed

  const names = collected.map((e) => e.event)
  assert.deepStrictEqual(names, ['pi.error', 'run.completed'])
  assert.equal(collected[1].data.status, 'error')
  assert.match(String(collected[1].data.error), /auth missing/)

  assert.equal(await ctx.runStore.getStatus('r1'), 'error')
  assert.equal(ctx.tracker.getActive('s1'), null)
})

// ---- malformed stdout -------------------------------------------------------

test('malformed JSON during an active run terminalizes the run', async () => {
  const ctx = await makeBridge()
  const collected = []
  ctx.bus.subscribe((e) => collected.push(e))

  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'hi')

  const completed = waitForEvent(ctx.bus, 'run.completed')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'hi' })
  const fake = ctx.getFake()

  // Send a successful response first so backoff is reset, then a bad line.
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  // Silence the bridge's diagnostic console.error for the malformed line.
  const origErr = console.error
  console.error = () => {}
  fake.pushRaw('this is not json\n')

  await completed
  console.error = origErr

  const names = collected.map((e) => e.event)
  assert.deepStrictEqual(names, ['pi.error', 'run.completed'])
  assert.equal(collected[1].data.status, 'error')
  assert.equal(await ctx.runStore.getStatus('r1'), 'error')
})

// ---- child crash ------------------------------------------------------------

test('child crash before run.completed terminalizes once (no double pi.error/run.completed)', async () => {
  const ctx = await makeBridge()
  const collected = []
  ctx.bus.subscribe((e) => collected.push(e))

  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'hi')

  const completed = waitForEvent(ctx.bus, 'run.completed')
  const turnStarted = waitForEvent(ctx.bus, 'turn.start')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'hi' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  fake.pushJson({ type: 'turn_start' })
  // Wait until the bridge has actually processed the turn_start before crashing,
  // otherwise the exit can fire while the JSON parse loop is still pending.
  await turnStarted
  fake.crash(137, 'SIGKILL')

  await completed
  // Give onExit's idempotent guard a beat in case it tries to do more.
  await new Promise((r) => setTimeout(r, 50))

  const names = collected.map((e) => e.event)
  // Should be: run.start, turn.start, pi.error, run.completed — no duplicates.
  assert.deepStrictEqual(names, ['run.start', 'turn.start', 'pi.error', 'run.completed'])
  assert.equal(collected[3].data.status, 'error')
  assert.equal(await ctx.runStore.getStatus('r1'), 'error')
  assert.equal(ctx.tracker.getActive('s1'), null)
})

test('child crash AFTER run.completed does NOT synthesize a second terminal sequence', async () => {
  const ctx = await makeBridge()
  const collected = []
  ctx.bus.subscribe((e) => collected.push(e))

  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'hi')

  const completed = waitForEvent(ctx.bus, 'run.completed')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'hi' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  fake.pushJson({ type: 'turn_start' })
  fake.pushJson({ type: 'turn_end' })
  fake.pushJson({ type: 'agent_end', messages: [] })
  await completed

  // Now simulate child exit. Should be a no-op for the (already finished) run.
  fake.crash(0, null)
  await new Promise((r) => setTimeout(r, 50))

  const names = collected.map((e) => e.event)
  assert.deepStrictEqual(names, ['run.start', 'turn.start', 'turn.end', 'run.completed'])
  assert.equal(await ctx.runStore.getStatus('r1'), 'success')
})

// ---- BRIDGE_BUSY ------------------------------------------------------------

test('a second send while a run is active throws BRIDGE_BUSY with the active runId', async () => {
  const ctx = await makeBridge()
  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'hi')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'hi' })

  let caught
  try {
    await ctx.bridge.send({ sessionKey: 's2', runId: 'r2', prompt: 'other' })
  } catch (err) {
    caught = err
  }
  assert.ok(caught)
  assert.equal(caught.code, 'BRIDGE_BUSY')
  assert.equal(caught.activeRunId, 'r1')
})

// ---- session resets between runs --------------------------------------------

test('after a clean run, a fresh send works for a new runId', async () => {
  const ctx = await makeBridge()

  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'hi')
  const completed1 = waitForEvent(ctx.bus, 'run.completed')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'hi' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  fake.pushJson({ type: 'agent_end', messages: [] })
  await completed1

  // Fresh send on the same bridge (pi child still alive).
  ctx.tracker.start('s1', 'r2')
  await startRunOnDisk(ctx.runStore, 'r2', 's1', 'next')
  const completed2 = waitForEvent(ctx.bus, 'run.completed')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r2', prompt: 'next' })

  // Bridge should have written a new prompt with id=r2.
  const cmds = fake.linesIn.map((l) => JSON.parse(l))
  assert.equal(cmds.length, 2)
  assert.equal(cmds[1].id, 'r2')
  assert.equal(cmds[1].message, 'next')

  fake.pushJson({ id: 'r2', type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  fake.pushJson({ type: 'agent_end', messages: [] })
  await completed2

  assert.equal(await ctx.runStore.getStatus('r2'), 'success')
})
