/**
 * Coverage for src/server/kb-index-generator.ts.
 *   - empty kb → minimal markdown + a stable hash
 *   - skills + memory + agents + workflows render in deterministic order
 *   - same kb state → byte-identical body (timestamp excluded from hash)
 *   - different kb state → different hash
 *   - regenerate is idempotent (skips writing when hash matches)
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildKbIndex, regenerateKbIndex } from '../src/server/kb-index-generator.ts'

async function tmpKbRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-idx-'))
  await Promise.all([
    fs.mkdir(path.join(root, 'skills'),    { recursive: true }),
    fs.mkdir(path.join(root, 'memory'),    { recursive: true }),
    fs.mkdir(path.join(root, 'agents'),    { recursive: true }),
    fs.mkdir(path.join(root, 'workflows'), { recursive: true }),
  ])
  return root
}

async function writeSkill(root, name, description = 'a test skill', body = 'body') {
  const dir = path.join(root, 'skills', name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"\n---\n${body}`)
}

async function writeMemory(root, name, body) {
  await fs.writeFile(path.join(root, 'memory', `${name}.md`), body)
}

describe('buildKbIndex', () => {
  it('renders an empty kb with zero counts and a stable hash', async () => {
    const root = await tmpKbRoot()
    const idx = await buildKbIndex(root)
    assert.equal(idx.counts.skills, 0)
    assert.equal(idx.counts.memory, 0)
    assert.equal(idx.counts.agents, 0)
    assert.equal(idx.counts.workflows, 0)
    assert.match(idx.markdown, /^<!-- generated:/)
    assert.match(idx.markdown, /## Skills \(0\)/)
    assert.match(idx.markdown, /^INDEX_HASH: [a-f0-9]{64}$/m)
    assert.equal(typeof idx.hash, 'string')
    assert.equal(idx.hash.length, 64)
  })

  it('includes skills with name + description', async () => {
    const root = await tmpKbRoot()
    await writeSkill(root, 'query-jira', 'Query Jira via mcp-atlassian (preferred) or REST.')
    await writeSkill(root, 'query-snow', 'Query ServiceNow via the servicenow MCP.')
    const idx = await buildKbIndex(root)
    assert.equal(idx.counts.skills, 2)
    assert.match(idx.markdown, /`query-jira`.*Query Jira/)
    assert.match(idx.markdown, /`query-snow`.*Query ServiceNow/)
  })

  it('includes memory entries with size + mtime', async () => {
    const root = await tmpKbRoot()
    await writeMemory(root, 'user', 'prefers terse answers')
    await writeMemory(root, 'project', 'dev SNOW: https://x.example')
    const idx = await buildKbIndex(root)
    assert.equal(idx.counts.memory, 2)
    assert.match(idx.markdown, /`user`.*\d+ bytes/)
    assert.match(idx.markdown, /`project`.*\d+ bytes/)
  })

  it('produces the SAME hash for the same kb state (timestamp excluded)', async () => {
    const root = await tmpKbRoot()
    await writeSkill(root, 'a', 'skill a')
    const idx1 = await buildKbIndex(root)
    // Wait a tick so any wall-clock millisecond drift would differ.
    await new Promise((r) => setTimeout(r, 5))
    const idx2 = await buildKbIndex(root)
    assert.equal(idx1.hash, idx2.hash)
  })

  it('produces a DIFFERENT hash when a skill is added', async () => {
    const root = await tmpKbRoot()
    await writeSkill(root, 'a', 'skill a')
    const idx1 = await buildKbIndex(root)
    await writeSkill(root, 'b', 'skill b')
    const idx2 = await buildKbIndex(root)
    assert.notEqual(idx1.hash, idx2.hash)
  })

  it('produces a DIFFERENT hash when a memory entry changes size', async () => {
    const root = await tmpKbRoot()
    await writeMemory(root, 'user', 'short')
    const idx1 = await buildKbIndex(root)
    await writeMemory(root, 'user', 'now this is a much longer memory entry body')
    const idx2 = await buildKbIndex(root)
    assert.notEqual(idx1.hash, idx2.hash)
  })

  it('orders entries deterministically by name', async () => {
    const root = await tmpKbRoot()
    await writeSkill(root, 'zulu', 'z')
    await writeSkill(root, 'alpha', 'a')
    await writeSkill(root, 'mike', 'm')
    const idx = await buildKbIndex(root)
    const aIdx = idx.markdown.indexOf('`alpha`')
    const mIdx = idx.markdown.indexOf('`mike`')
    const zIdx = idx.markdown.indexOf('`zulu`')
    assert.ok(aIdx >= 0 && mIdx > aIdx && zIdx > mIdx, 'skills must render alphabetically')
  })
})

describe('regenerateKbIndex', () => {
  it('writes index.md to disk', async () => {
    const root = await tmpKbRoot()
    await writeSkill(root, 'x', 'x skill')
    await regenerateKbIndex(root)
    const text = await fs.readFile(path.join(root, 'index.md'), 'utf8')
    assert.match(text, /^<!-- generated:/)
    assert.match(text, /`x`.*x skill/)
    assert.match(text, /^INDEX_HASH: [a-f0-9]{64}$/m)
  })

  it('is idempotent: rewriting the same kb does not bump mtime when hash matches', async () => {
    const root = await tmpKbRoot()
    await writeSkill(root, 'x', 'x skill')
    await regenerateKbIndex(root)
    const stat1 = await fs.stat(path.join(root, 'index.md'))
    await new Promise((r) => setTimeout(r, 10))
    await regenerateKbIndex(root)
    const stat2 = await fs.stat(path.join(root, 'index.md'))
    assert.equal(stat1.mtimeMs, stat2.mtimeMs, 'no-change regen must skip the write')
  })

  it('rewrites when the hash actually changes', async () => {
    const root = await tmpKbRoot()
    await writeSkill(root, 'x', 'x skill')
    await regenerateKbIndex(root)
    const stat1 = await fs.stat(path.join(root, 'index.md'))
    await new Promise((r) => setTimeout(r, 5))
    await writeSkill(root, 'y', 'y skill')
    await regenerateKbIndex(root)
    const stat2 = await fs.stat(path.join(root, 'index.md'))
    assert.ok(stat2.mtimeMs > stat1.mtimeMs, 'new content must trigger a rewrite')
  })
})
