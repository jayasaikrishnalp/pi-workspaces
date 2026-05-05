import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { KbEventBus } from '../src/server/kb-event-bus.ts'
import { KbWatcher } from '../src/server/kb-watcher.ts'

function tmpSkillsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-watcher-'))
}

function waitForEvent(bus, predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      unsub()
      reject(new Error(`waitForEvent timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    const unsub = bus.subscribe((e) => {
      if (predicate(e)) {
        clearTimeout(t)
        unsub()
        resolve(e)
      }
    })
  })
}

test('atomic tmp+rename produces exactly one add event', async () => {
  const dir = tmpSkillsDir()
  const bus = new KbEventBus()
  const watcher = new KbWatcher({
    skillsDir: dir,
    bus,
    stabilityThreshold: 100,
    pollInterval: 25,
  })
  await watcher.start()
  try {
    const events = []
    bus.subscribe((e) => events.push(e))
    const skillDir = path.join(dir, 'new-skill')
    fs.mkdirSync(skillDir, { recursive: true })
    const tmp = path.join(skillDir, 'SKILL.md.tmp')
    const final = path.join(skillDir, 'SKILL.md')
    fs.writeFileSync(tmp, `---\nname: new-skill\n---\n# new\n`)
    fs.renameSync(tmp, final)
    await waitForEvent(bus, (e) => e.kind === 'add' && e.path === final, 3_000)
    // Allow any straggler events.
    await new Promise((r) => setTimeout(r, 250))
    const finalAdds = events.filter((e) => e.kind === 'add' && e.path === final)
    assert.equal(finalAdds.length, 1, `expected exactly 1 add for ${final}, got ${finalAdds.length}`)
    // The .tmp file must NOT have produced an event the consumer cares about.
    const tmpEvents = events.filter((e) => e.path === tmp)
    assert.equal(tmpEvents.length, 0, `tmp file should not produce a stable event; got ${JSON.stringify(tmpEvents)}`)
  } finally {
    await watcher.stop()
  }
})

test('unlink emits unlink event', async () => {
  const dir = tmpSkillsDir()
  // Pre-populate so the unlink target exists when the watcher starts.
  const skillDir = path.join(dir, 'will-go')
  fs.mkdirSync(skillDir, { recursive: true })
  const skillPath = path.join(skillDir, 'SKILL.md')
  fs.writeFileSync(skillPath, `---\nname: will-go\n---\n`)

  const bus = new KbEventBus()
  const watcher = new KbWatcher({ skillsDir: dir, bus, stabilityThreshold: 100, pollInterval: 25 })
  await watcher.start()
  try {
    fs.unlinkSync(skillPath)
    const evt = await waitForEvent(bus, (e) => e.kind === 'unlink' && e.path === skillPath, 3_000)
    assert.equal(evt.skill, 'will-go')
  } finally {
    await watcher.stop()
  }
})

test('initial scan emits add events for pre-existing files (ignoreInitial:false)', async () => {
  const dir = tmpSkillsDir()
  const skillDir = path.join(dir, 'pre-existing')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: pre-existing\n---\n`)

  const bus = new KbEventBus()
  const events = []
  bus.subscribe((e) => events.push(e))
  const watcher = new KbWatcher({ skillsDir: dir, bus, stabilityThreshold: 100, pollInterval: 25 })
  await watcher.start()
  try {
    // After start() resolves, all initial-scan events should have been emitted.
    const adds = events.filter((e) => e.kind === 'add')
    assert.ok(adds.length >= 1, `expected at least one initial add; got ${adds.length}`)
    assert.ok(adds.some((e) => e.path.endsWith('SKILL.md')))
  } finally {
    await watcher.stop()
  }
})
