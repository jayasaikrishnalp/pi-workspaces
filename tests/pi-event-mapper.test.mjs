import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import { mapPiEvent, INITIAL_STATE } from '../src/events/index.ts'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const FIX_DIR = path.join(__dirname, 'fixtures', 'pi-event-mapper')
const REAL_PI_DIR = path.join(FIX_DIR, 'real-pi')

function readJsonl(file) {
  const raw = fs.readFileSync(file, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line, idx) => {
      try {
        return JSON.parse(line)
      } catch (err) {
        throw new Error(`${path.basename(file)}:${idx + 1} invalid JSON: ${err.message}`)
      }
    })
}

function makeCtx(overrides = {}) {
  let t = 0
  let m = 0
  return {
    runId: 'r1',
    sessionKey: 's1',
    prompt: 'hello',
    nextTurnId: () => `t-${++t}`,
    nextMessageId: () => `m-${++m}`,
    ...overrides,
  }
}

function replay(inputs, ctxOverrides) {
  const ctx = makeCtx(ctxOverrides)
  let state = INITIAL_STATE
  const perInput = []
  for (const piEvent of inputs) {
    const result = mapPiEvent(piEvent, state, ctx)
    perInput.push(result.events)
    state = result.state
  }
  return { perInput, finalState: state }
}

function listScenarios() {
  return fs
    .readdirSync(FIX_DIR)
    .filter((f) => f.endsWith('.in.jsonl'))
    .map((f) => f.replace(/\.in\.jsonl$/, ''))
    .sort()
}

const SCENARIOS = listScenarios()

test('fixture coverage: every scenario has matching .out.jsonl and .note.md', () => {
  for (const s of SCENARIOS) {
    assert.ok(fs.existsSync(path.join(FIX_DIR, `${s}.out.jsonl`)), `missing ${s}.out.jsonl`)
    assert.ok(fs.existsSync(path.join(FIX_DIR, `${s}.note.md`)), `missing ${s}.note.md`)
  }
})

for (const scenario of SCENARIOS) {
  test(`fixture: ${scenario}`, () => {
    const inputs = readJsonl(path.join(FIX_DIR, `${scenario}.in.jsonl`))
    const expected = readJsonl(path.join(FIX_DIR, `${scenario}.out.jsonl`))
    assert.equal(
      inputs.length,
      expected.length,
      `${scenario}: input/output line count mismatch (${inputs.length} vs ${expected.length})`,
    )
    const { perInput } = replay(inputs)
    for (let i = 0; i < inputs.length; i++) {
      assert.deepStrictEqual(
        perInput[i],
        expected[i],
        `${scenario}: line ${i + 1} mismatch\ninput:    ${JSON.stringify(inputs[i])}\nexpected: ${JSON.stringify(expected[i])}\nactual:   ${JSON.stringify(perInput[i])}`,
      )
    }
  })
}

test('tool-call shape tolerance: real-pi nested toolCall and flat spike shape produce equivalent normalized events', () => {
  // Same logical sequence (turn_start, start/delta/end), different physical
  // shapes. Normalized outputs must agree on event names and turnId/toolCallId.
  const real = replay(readJsonl(path.join(FIX_DIR, 'tool-call.in.jsonl'))).perInput
  const spike = replay(readJsonl(path.join(FIX_DIR, 'tool-call-spike-shape.in.jsonl'))).perInput
  assert.equal(real.length, spike.length)
  for (let i = 0; i < real.length; i++) {
    const a = real[i]
    const b = spike[i]
    assert.equal(a.length, b.length, `line ${i + 1} length mismatch`)
    for (let j = 0; j < a.length; j++) {
      assert.equal(a[j].event, b[j].event, `line ${i + 1} event ${j} name`)
      assert.equal(a[j].data.runId, b[j].data.runId, `line ${i + 1} event ${j} runId`)
      assert.equal(a[j].data.turnId, b[j].data.turnId, `line ${i + 1} event ${j} turnId`)
      if (a[j].data.toolCallId !== undefined) {
        assert.ok(typeof b[j].data.toolCallId === 'string' && b[j].data.toolCallId.length > 0,
          `line ${i + 1} event ${j} spike output missing toolCallId`)
      }
    }
  }
})

test('purity: same input twice produces structurally equal results and never mutates input', () => {
  const inputs = readJsonl(path.join(FIX_DIR, 'message-assistant.in.jsonl'))
  const inputsCopyJson = JSON.stringify(inputs)
  const a = replay(inputs)
  const b = replay(inputs)
  assert.deepStrictEqual(b.perInput, a.perInput, 'replay must be deterministic')
  assert.deepStrictEqual(b.finalState, a.finalState, 'final state must be deterministic')
  assert.equal(JSON.stringify(inputs), inputsCopyJson, 'mapper must not mutate the input pi events')
})

test('malformed inputs do not throw and leave state unchanged', () => {
  const ctx = makeCtx()
  const inputs = [null, undefined, 'string', 42, [], {}, { type: '' }, { type: 123 }]
  let state = { currentTurnId: 'preserved', currentMessageId: 'm-prev' }
  for (const e of inputs) {
    const r = mapPiEvent(e, state, ctx)
    assert.deepStrictEqual(r.events, [], `expected empty events for ${JSON.stringify(e)}`)
    assert.deepStrictEqual(r.state, state, 'state must be unchanged for malformed input')
    state = r.state
  }
})

test('agent_start resets per-run state from a stale prior run', () => {
  const stale = { currentTurnId: 't-prev', currentMessageId: 'm-prev' }
  const r = mapPiEvent({ type: 'agent_start' }, stale, makeCtx())
  assert.deepStrictEqual(r.state, { currentTurnId: null, currentMessageId: null })
})

test('agent_end resets state even if turn_end / message_end were missing', () => {
  const dirty = { currentTurnId: 't-1', currentMessageId: 'm-1' }
  const r = mapPiEvent({ type: 'agent_end' }, dirty, makeCtx())
  assert.deepStrictEqual(r.state, { currentTurnId: null, currentMessageId: null })
})

test('lifecycle final state is clean after a normal run', () => {
  const inputs = readJsonl(path.join(FIX_DIR, 'lifecycle.in.jsonl'))
  const { finalState } = replay(inputs)
  assert.deepStrictEqual(finalState, { currentTurnId: null, currentMessageId: null })
})

test('message-assistant final state has currentMessageId cleared after message_end', () => {
  const inputs = readJsonl(path.join(FIX_DIR, 'message-assistant.in.jsonl'))
  const { finalState } = replay(inputs)
  assert.deepStrictEqual(finalState, { currentTurnId: null, currentMessageId: null })
})

// ---------------------------------------------------------------------------
// Snapshot tests: full normalized event sequence for each captured real-pi
// trace must match the committed expected file line for line. Update procedure:
// `node --import tsx gen-snapshots.mjs` from the repo root after a deliberate
// mapper change, review the diff, commit.

for (const snap of ['pi-json-hello', 'pi-json-tool']) {
  test(`real-pi snapshot: ${snap}`, () => {
    const inputs = readJsonl(path.join(REAL_PI_DIR, `${snap}.jsonl`))
    const expected = readJsonl(path.join(REAL_PI_DIR, `${snap}.expected.jsonl`))
    assert.equal(inputs.length, expected.length, `${snap}: input/expected line count mismatch`)
    const { perInput, finalState } = replay(inputs)
    for (let i = 0; i < inputs.length; i++) {
      assert.deepStrictEqual(
        perInput[i],
        expected[i],
        `${snap}: line ${i + 1} mismatch\nactual:   ${JSON.stringify(perInput[i])}\nexpected: ${JSON.stringify(expected[i])}`,
      )
    }
    assert.deepStrictEqual(finalState, { currentTurnId: null, currentMessageId: null })
  })
}
