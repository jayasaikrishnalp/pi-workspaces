/**
 * Coverage for src/server/memory-snapshot.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loadMemorySnapshot, wrapPromptWithMemory } from '../src/server/memory-snapshot.ts'

describe('loadMemorySnapshot', () => {
  it('returns null when kbRoot is undefined', async () => {
    const r = await loadMemorySnapshot(undefined)
    assert.equal(r, null)
  })

  it('returns null when both files are absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-snap-'))
    const r = await loadMemorySnapshot(root)
    assert.equal(r, null)
  })

  it('returns null when files exist but are empty / whitespace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-snap-'))
    await fs.mkdir(path.join(root, 'memory'))
    await fs.writeFile(path.join(root, 'memory', 'user.md'), '   \n\n')
    await fs.writeFile(path.join(root, 'memory', 'project.md'), '')
    const r = await loadMemorySnapshot(root)
    assert.equal(r, null)
  })

  it('renders user-only when only user.md exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-snap-'))
    await fs.mkdir(path.join(root, 'memory'))
    await fs.writeFile(path.join(root, 'memory', 'user.md'), 'prefers terse answers')
    const r = await loadMemorySnapshot(root)
    assert.match(r, /USER PROFILE/)
    assert.match(r, /prefers terse answers/)
    assert.doesNotMatch(r, /PROJECT FACTS/)
  })

  it('renders both sections when both files exist', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-snap-'))
    await fs.mkdir(path.join(root, 'memory'))
    await fs.writeFile(path.join(root, 'memory', 'user.md'), 'prefers terse answers')
    await fs.writeFile(path.join(root, 'memory', 'project.md'), 'dev SNOW: https://devwolterskluwer.service-now.com')
    const r = await loadMemorySnapshot(root)
    assert.match(r, /USER PROFILE/)
    assert.match(r, /prefers terse answers/)
    assert.match(r, /PROJECT FACTS/)
    assert.match(r, /devwolterskluwer/)
  })
})

describe('wrapPromptWithMemory', () => {
  it('wraps the snapshot in a memory-context block before the user prompt', () => {
    const out = wrapPromptWithMemory('USER PROFILE\n- foo', 'Look up RITM1873461')
    assert.match(out, /^<memory-context>/)
    assert.match(out, /\[System note:/)
    assert.match(out, /USER PROFILE/)
    assert.match(out, /<\/memory-context>/)
    // The user prompt MUST come AFTER the closing tag so pi sees the
    // memory as background, the prompt as the live request.
    const closingIdx = out.indexOf('</memory-context>')
    const promptIdx = out.indexOf('Look up RITM1873461')
    assert.ok(closingIdx >= 0 && promptIdx > closingIdx, 'prompt must follow </memory-context>')
  })
})
