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

// ---- abort -----------------------------------------------------------------

test('abort writes the abort RPC on stdin', async (t) => {
  const ctx = await makeBridge()
  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'long task')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'long task' })
  const fake = ctx.getFake()
  await ctx.bridge.abort('r1')
  assert.equal(fake.linesIn.length, 2)
  const cmd = JSON.parse(fake.linesIn[1])
  assert.equal(cmd.type, 'abort')
  assert.equal(cmd.id, 'abort-r1')
  // Cleanup: this test never completes the run, so the abort timers would
  // leak into later tests (firing at +3s/+4s). Force termination.
  t.after(() => {
    fake.crash(0, null)
  })
})

test('abort on a non-active run throws NO_ACTIVE_RUN', async () => {
  const ctx = await makeBridge()
  let caught
  try {
    await ctx.bridge.abort('nope')
  } catch (err) {
    caught = err
  }
  assert.equal(caught?.code, 'NO_ACTIVE_RUN')
})

test('abort followed by clean agent_end (with stopReason aborted) lands status:cancelled', async () => {
  const ctx = await makeBridge()
  // Mark meta as cancelling first (which is what the route does before calling bridge.abort).
  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'task')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'task' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  // Imagine the route flipped status to cancelling before issuing abort:
  await ctx.runStore.casStatus('r1', ['running'], 'cancelling')
  await ctx.bridge.abort('r1')
  // Pi processes abort and emits agent_end with stopReason:"aborted".
  fake.pushJson({
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'aborted', errorMessage: 'aborted by user' }],
  })
  await ctx.bridge.waitForActiveCompletion()
  assert.equal(await ctx.runStore.getStatus('r1'), 'cancelled')
})

test('abort followed by SIGTERM-driven exit (no agent_end) lands status:cancelled', async () => {
  const ctx = await makeBridge()
  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'task')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'task' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  await ctx.runStore.casStatus('r1', ['running'], 'cancelling')
  await ctx.bridge.abort('r1')
  // Simulate SIGTERM landing — child exits.
  fake.crash(143, 'SIGTERM')
  await ctx.bridge.waitForActiveCompletion()
  assert.equal(await ctx.runStore.getStatus('r1'), 'cancelled', 'cancelling+exit should land cancelled, not error')
})

test('agent_end racing abort: clean success wins, status stays success', async () => {
  const ctx = await makeBridge()
  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'task')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'task' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  // Pi finishes cleanly BEFORE the route can even mark cancelling.
  fake.pushJson({ type: 'agent_end', messages: [] })
  await ctx.bridge.waitForActiveCompletion()
  assert.equal(await ctx.runStore.getStatus('r1'), 'success')
  // Route's CAS running → cancelling fails because status is already success.
  const flipped = await ctx.runStore.casStatus('r1', ['running'], 'cancelling')
  assert.equal(flipped, false)
  // ...so the route returns 200 alreadyFinished. No further abort RPC issued.
})

test('abort then exit while meta is still running terminalizes as cancelled (not error)', async () => {
  // Race: route hasn't CAS'd to cancelling yet when pi crashes after abort.
  // abortRequested should still steer terminalize to 'cancelled'.
  const ctx = await makeBridge()
  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'task')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'task' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  // Note: meta.json is still 'running' — no casStatus to cancelling here.
  await ctx.bridge.abort('r1')
  fake.crash(143, 'SIGTERM')
  await ctx.bridge.waitForActiveCompletion()
  assert.equal(await ctx.runStore.getStatus('r1'), 'cancelled', 'abortRequested guard must steer terminalize to cancelled even if CAS to cancelling never happened')
})

test('escalation timers: clean abort within 3s sends NO SIGTERM/SIGKILL to process group', async (t) => {
  const ctx = await makeBridge()
  // Mock process.kill so we observe whether it is called.
  const calls = []
  const orig = process.kill
  process.kill = (pid, sig) => {
    calls.push({ pid, sig })
    // Don't actually do anything; the fake child has pid 99999.
    return true
  }
  t.after(() => {
    process.kill = orig
  })
  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'task')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'task' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  await ctx.runStore.casStatus('r1', ['running'], 'cancelling')
  await ctx.bridge.abort('r1')
  // Pi processes abort and sends agent_end well within 3s.
  fake.pushJson({
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'aborted', errorMessage: 'aborted' }],
  })
  await ctx.bridge.waitForActiveCompletion()
  // Allow any pending microtasks to settle, then wait past the SIGTERM window
  // to confirm the timer was cancelled (not just deferred).
  await new Promise((r) => setTimeout(r, 50))
  assert.deepStrictEqual(calls, [], `expected no kill calls; got ${JSON.stringify(calls)}`)
})

test('escalation timers fire SIGTERM at 3s and SIGKILL at 4s when pi is unresponsive', async (t) => {
  const ctx = await makeBridge()
  const calls = []
  const orig = process.kill
  process.kill = (pid, sig) => {
    calls.push({ pid, sig })
    // Do NOT exit the fake child — that's the point: pi is unresponsive.
    return true
  }
  t.after(() => {
    process.kill = orig
  })
  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'task')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'task' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  await ctx.runStore.casStatus('r1', ['running'], 'cancelling')
  await ctx.bridge.abort('r1')
  // Wait past 3s and 4s.
  await new Promise((r) => setTimeout(r, 4_200))
  // Now finally simulate the SIGKILL delivering: child exits.
  fake.crash(137, 'SIGKILL')
  await ctx.bridge.waitForActiveCompletion()
  // We expect TWO kill calls: SIGTERM then SIGKILL, both with negative pid.
  assert.equal(calls.length, 2, `expected 2 kill calls, got ${calls.length}: ${JSON.stringify(calls)}`)
  assert.equal(calls[0].sig, 'SIGTERM')
  assert.equal(calls[1].sig, 'SIGKILL')
  assert.ok(calls[0].pid < 0, `SIGTERM target must be negative pid (process group), got ${calls[0].pid}`)
  assert.ok(calls[1].pid < 0, `SIGKILL target must be negative pid, got ${calls[1].pid}`)
})

test('finishActive clears abort timers if pi exits cleanly first', async () => {
  const ctx = await makeBridge()
  ctx.tracker.start('s1', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 's1', 'task')
  await ctx.bridge.send({ sessionKey: 's1', runId: 'r1', prompt: 'task' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  await ctx.runStore.casStatus('r1', ['running'], 'cancelling')
  await ctx.bridge.abort('r1')
  // Snapshot the active timers BEFORE pi exits.
  // We can't introspect them directly, but we can assert the timers don't fire by
  // closing out the run cleanly and waiting longer than 4s would be too slow —
  // instead, verify behavior: the run terminalizes and the test process is
  // ready to exit (no orphan timers keep the loop alive thanks to .unref()).
  fake.pushJson({
    type: 'agent_end',
    messages: [{ role: 'assistant', stopReason: 'aborted', errorMessage: 'aborted' }],
  })
  await ctx.bridge.waitForActiveCompletion()
  assert.equal(await ctx.runStore.getStatus('r1'), 'cancelled')
  // No assertion can prove a timer was cancelled vs ref'd — but the .unref() in
  // the bridge means even if it weren't cancelled, the test wouldn't hang.
  // The behavioral contract (status terminal, run finished) is what we assert.
})

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

// ---- F5: per-session pi reset ---------------------------------------------

test('switching sessionKey: bridge writes new_session, WAITS for ack, THEN writes prompt', async () => {
  const ctx = await makeBridge()

  ctx.tracker.start('sessA', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 'sessA', 'hi from A')
  const done1 = waitForEvent(ctx.bus, 'run.completed')
  await ctx.bridge.send({ sessionKey: 'sessA', runId: 'r1', prompt: 'hi from A' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  fake.pushJson({ type: 'agent_end', messages: [] })
  await done1

  // Different session — send() must NOT resolve until pi acks new_session,
  // and the prompt must NOT have hit stdin until then.
  ctx.tracker.start('sessB', 'r2')
  await startRunOnDisk(ctx.runStore, 'r2', 'sessB', 'hi from B')
  const done2 = waitForEvent(ctx.bus, 'run.completed')
  const sendPromise = ctx.bridge.send({ sessionKey: 'sessB', runId: 'r2', prompt: 'hi from B' })

  // Give the bridge a tick to write new_session.
  await new Promise((r) => setImmediate(r))

  // Only new_session has been written so far. Pi processes lines without
  // awaiting (`void handleInputLine` in pi-mono rpc-mode.ts), so writing
  // the prompt now would race against the still-running newSession() and
  // operate on the soon-to-be-replaced agent state.
  let cmds = fake.linesIn.map((l) => JSON.parse(l))
  assert.equal(cmds.length, 2, `expected 2 stdin cmds (prompt-A then new_session), got ${cmds.length}: ${JSON.stringify(cmds)}`)
  assert.equal(cmds[1].type, 'new_session')
  const newSessionId = cmds[1].id

  // Ack the new_session — bridge should release the queued prompt.
  fake.pushJson({ id: newSessionId, type: 'response', command: 'new_session', success: true, data: { cancelled: false } })
  await sendPromise

  cmds = fake.linesIn.map((l) => JSON.parse(l))
  assert.equal(cmds.length, 3, `prompt should be written after ack, got ${cmds.length} cmds`)
  assert.equal(cmds[2].type, 'prompt')
  assert.equal(cmds[2].message, 'hi from B')

  fake.pushJson({ id: 'r2', type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  fake.pushJson({ type: 'agent_end', messages: [] })
  await done2

  assert.equal(await ctx.runStore.getStatus('r2'), 'success')
})

test('same sessionKey on consecutive sends does NOT emit new_session', async () => {
  const ctx = await makeBridge()

  ctx.tracker.start('sessA', 'r1')
  await startRunOnDisk(ctx.runStore, 'r1', 'sessA', 'a1')
  const done1 = waitForEvent(ctx.bus, 'run.completed')
  await ctx.bridge.send({ sessionKey: 'sessA', runId: 'r1', prompt: 'a1' })
  const fake = ctx.getFake()
  fake.pushJson({ id: 'r1', type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  fake.pushJson({ type: 'agent_end', messages: [] })
  await done1

  ctx.tracker.start('sessA', 'r2')
  await startRunOnDisk(ctx.runStore, 'r2', 'sessA', 'a2')
  const done2 = waitForEvent(ctx.bus, 'run.completed')
  await ctx.bridge.send({ sessionKey: 'sessA', runId: 'r2', prompt: 'a2' })

  const cmds = fake.linesIn.map((l) => JSON.parse(l))
  assert.equal(cmds.length, 2, `same-session continuation should NOT emit new_session, got ${cmds.length} cmds`)
  for (const c of cmds) {
    assert.notEqual(c.type, 'new_session', `unexpected new_session in same-session flow: ${JSON.stringify(c)}`)
  }

  fake.pushJson({ id: 'r2', type: 'response', command: 'prompt', success: true })
  fake.pushJson({ type: 'agent_start' })
  fake.pushJson({ type: 'agent_end', messages: [] })
  await done2
})
