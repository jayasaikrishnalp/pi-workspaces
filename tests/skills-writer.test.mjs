import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  writeSkill,
  renderFrontmatter,
  SkillWriteError,
  SKILL_NAME_RE,
} from '../src/server/skills-writer.ts'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-writer-'))
}

test('SKILL_NAME_RE allows the documented shape', () => {
  assert.ok(SKILL_NAME_RE.test('a'))
  assert.ok(SKILL_NAME_RE.test('reboot-server'))
  assert.ok(SKILL_NAME_RE.test('a1b2-c3'))
  assert.ok(!SKILL_NAME_RE.test('A'))
  assert.ok(!SKILL_NAME_RE.test('1bad'))
  assert.ok(!SKILL_NAME_RE.test('with space'))
  assert.ok(!SKILL_NAME_RE.test(''))
  assert.ok(!SKILL_NAME_RE.test('a'.repeat(65)))
})

test('writeSkill writes SKILL.md atomically and removes any tmp file', async () => {
  const dir = tmpDir()
  const r = await writeSkill(dir, { name: 'foo', content: '# Foo\n', frontmatter: { description: 'x' } })
  assert.equal(r.relPath, 'foo/SKILL.md')
  const text = fs.readFileSync(r.absPath, 'utf8')
  // Frontmatter has name first, then description (sorted alpha after name).
  assert.match(text, /^---\nname: foo\ndescription: x\n---\n# Foo\n/)
  // No tmp files linger.
  const entries = fs.readdirSync(path.dirname(r.absPath))
  for (const e of entries) {
    assert.ok(!e.includes('.tmp.'), `unexpected tmp file: ${e}`)
  }
})

test('writeSkill rejects an existing skill with SKILL_EXISTS', async () => {
  const dir = tmpDir()
  await writeSkill(dir, { name: 'dup', content: 'x' })
  await assert.rejects(() => writeSkill(dir, { name: 'dup', content: 'y' }), (err) => {
    assert.ok(err instanceof SkillWriteError)
    assert.equal(err.code, 'SKILL_EXISTS')
    return true
  })
})

test('writeSkill rejects names not matching SKILL_NAME_RE', async () => {
  const dir = tmpDir()
  for (const bad of ['', 'A', '1bad', 'with space', 'a'.repeat(65)]) {
    await assert.rejects(() => writeSkill(dir, { name: bad, content: 'x' }), (err) => {
      assert.equal(err.code, 'INVALID_SKILL_NAME')
      return true
    }, `name=${JSON.stringify(bad)}`)
  }
})

test('writeSkill rejects body > 32 KB with BODY_TOO_LARGE', async () => {
  const dir = tmpDir()
  await assert.rejects(() => writeSkill(dir, { name: 'big', content: 'x'.repeat(33_000) }), (err) => {
    assert.equal(err.code, 'BODY_TOO_LARGE')
    return true
  })
})

test('writeSkill always emits frontmatter name matching the request name', async () => {
  const dir = tmpDir()
  // Even if caller tries to pass a contradicting name, request name wins.
  const r = await writeSkill(dir, {
    name: 'real-name',
    content: '',
    frontmatter: { name: 'attacker-injected', description: 'x' },
  })
  const text = fs.readFileSync(r.absPath, 'utf8')
  assert.match(text, /name: real-name/)
  assert.doesNotMatch(text, /name: attacker-injected/)
})

test('renderFrontmatter quotes scalars containing YAML-significant characters', () => {
  const out = renderFrontmatter({ name: 'a', description: 'has: colon' })
  assert.match(out, /description: "has: colon"/)
})

test('renderFrontmatter renders string arrays as block arrays', () => {
  const out = renderFrontmatter({ name: 'a', tags: ['readonly', 'sre'] })
  assert.match(out, /tags:\n  - readonly\n  - sre/)
})

test('renderFrontmatter rejects non-string scalar values with INVALID_FRONTMATTER', () => {
  assert.throws(() => renderFrontmatter({ name: 'a', count: 5 }), (err) => {
    assert.equal(err.code, 'INVALID_FRONTMATTER')
    return true
  })
})

test('renderFrontmatter rejects mixed arrays (non-string items) with INVALID_FRONTMATTER', () => {
  assert.throws(() => renderFrontmatter({ name: 'a', tags: ['ok', 1] }), (err) => {
    assert.equal(err.code, 'INVALID_FRONTMATTER')
    return true
  })
})

test('writeSkill: concurrent calls for same name produce exactly one success and one SKILL_EXISTS', async () => {
  const dir = tmpDir()
  const [a, b] = await Promise.allSettled([
    writeSkill(dir, { name: 'racy', content: 'A' }),
    writeSkill(dir, { name: 'racy', content: 'B' }),
  ])
  const succeeded = [a, b].filter((r) => r.status === 'fulfilled')
  const failed = [a, b].filter((r) => r.status === 'rejected')
  assert.equal(succeeded.length, 1, `expected exactly one success, got ${succeeded.length}`)
  assert.equal(failed.length, 1)
  const err = failed[0].reason
  assert.equal(err.code, 'SKILL_EXISTS')
  const text = fs.readFileSync(path.join(dir, 'racy', 'SKILL.md'), 'utf8')
  assert.ok(text.endsWith('A') || text.endsWith('B'))
})

test('writeSkill: multibyte body counts as JS-string-length (32_768 chars cap)', async () => {
  const dir = tmpDir()
  // 32_768 emoji = 65_536 JS-string units (surrogate pairs). Should reject.
  const body = '😀'.repeat(32_768)
  await assert.rejects(() => writeSkill(dir, { name: 'big-emoji', content: body }), (err) => {
    assert.equal(err.code, 'BODY_TOO_LARGE')
    return true
  })
})
