import test from 'node:test'
import assert from 'node:assert/strict'

import { ChatEventBus } from '../src/server/chat-event-bus.ts'

function fake(seq) {
  return {
    event: 'turn.start',
    data: { runId: 'r1' },
    meta: { runId: 'r1', sessionKey: 's1', seq, eventId: `r1:${seq}` },
  }
}

test('subscriber attached before emit receives the event', () => {
  const bus = new ChatEventBus()
  const calls = []
  bus.subscribe((e) => calls.push(e.meta.seq))
  bus.emit(fake(1))
  bus.emit(fake(2))
  assert.deepStrictEqual(calls, [1, 2])
})

test('subscriber attached after an emit does not receive the past event', () => {
  const bus = new ChatEventBus()
  bus.emit(fake(1))
  const calls = []
  bus.subscribe((e) => calls.push(e.meta.seq))
  bus.emit(fake(2))
  assert.deepStrictEqual(calls, [2])
})

test('unsubscribe stops further deliveries', () => {
  const bus = new ChatEventBus()
  const calls = []
  const unsub = bus.subscribe((e) => calls.push(e.meta.seq))
  bus.emit(fake(1))
  unsub()
  bus.emit(fake(2))
  assert.deepStrictEqual(calls, [1])
})

test('a misbehaving subscriber does not stop other subscribers from receiving', () => {
  // Silence the bus's diagnostic console.error during this test.
  const origErr = console.error
  console.error = () => {}
  try {
    const bus = new ChatEventBus()
    const ok = []
    bus.subscribe(() => {
      throw new Error('boom')
    })
    bus.subscribe((e) => ok.push(e.meta.seq))
    bus.emit(fake(1))
    bus.emit(fake(2))
    assert.deepStrictEqual(ok, [1, 2])
  } finally {
    console.error = origErr
  }
})

test('a handler unsubscribing during emit does not break peer delivery', () => {
  const bus = new ChatEventBus()
  const ok = []
  const unsub1 = bus.subscribe(() => {
    unsub1()
  })
  bus.subscribe((e) => ok.push(e.meta.seq))
  bus.emit(fake(1))
  bus.emit(fake(2))
  assert.deepStrictEqual(ok, [1, 2])
})
