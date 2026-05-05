import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { buildGraph, skillNameForPath } from '../src/server/kb-browser.ts'

function tmpSkillsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kb-browser-'))
}

function writeSkill(skillsDir, name, content) {
  const dir = path.join(skillsDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content)
}

test('buildGraph on the seed skills produces 5 nodes and the expected edges', async () => {
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
  const seedDir = path.join(REPO, 'seed-skills')
  const g = await buildGraph(seedDir)
  assert.equal(g.nodes.length, 5, `expected 5 seed nodes, got ${g.nodes.length}`)
  const ids = g.nodes.map((n) => n.id).sort()
  assert.deepStrictEqual(ids, [
    'aws-cleanup',
    'check-server-health',
    'disk-cleanup',
    'patch-vm',
    'reboot-server',
  ])
  // reboot-server uses check-server-health
  const usesEdge = g.edges.find(
    (e) => e.source === 'reboot-server' && e.target === 'check-server-health' && e.kind === 'uses',
  )
  assert.ok(usesEdge, 'expected reboot-server uses check-server-health')
  // No diagnostics on the seeds (intentionally clean).
  assert.deepStrictEqual(g.diagnostics, [], `unexpected diagnostics: ${JSON.stringify(g.diagnostics)}`)
})

test('buildGraph emits a diagnostic when frontmatter is missing', async () => {
  const dir = tmpSkillsDir()
  writeSkill(dir, 'no-frontmatter', `# Hello\n\nNo frontmatter here.`)
  const g = await buildGraph(dir)
  assert.equal(g.nodes.length, 0)
  assert.equal(g.diagnostics.length, 1)
  assert.equal(g.diagnostics[0].severity, 'error')
  assert.match(g.diagnostics[0].path, /no-frontmatter\/SKILL\.md$/)
})

test('buildGraph emits a diagnostic when name is missing', async () => {
  const dir = tmpSkillsDir()
  writeSkill(
    dir,
    'no-name',
    `---\ndescription: missing name\n---\n# body\n`,
  )
  const g = await buildGraph(dir)
  assert.equal(g.nodes.length, 0)
  assert.equal(g.diagnostics.length, 1)
  assert.match(g.diagnostics[0].message, /name/)
})

test('buildGraph parses uses (block array) and emits a uses edge', async () => {
  const dir = tmpSkillsDir()
  writeSkill(
    dir,
    'a',
    `---\nname: a\n---\n# A\n`,
  )
  writeSkill(
    dir,
    'b',
    `---\nname: b\nuses:\n  - a\n---\n# B uses A\n`,
  )
  const g = await buildGraph(dir)
  assert.equal(g.nodes.length, 2)
  const usesEdge = g.edges.find((e) => e.kind === 'uses')
  assert.ok(usesEdge)
  assert.equal(usesEdge.source, 'b')
  assert.equal(usesEdge.target, 'a')
})

test('buildGraph parses uses (inline array) and emits a uses edge', async () => {
  const dir = tmpSkillsDir()
  writeSkill(dir, 'a', `---\nname: a\n---\n`)
  writeSkill(dir, 'c', `---\nname: c\nuses: [a]\n---\n# C uses A inline\n`)
  const g = await buildGraph(dir)
  assert.equal(g.nodes.length, 2)
  assert.ok(g.edges.find((e) => e.kind === 'uses' && e.source === 'c' && e.target === 'a'))
})

test('buildGraph emits a wikilink edge from the body', async () => {
  const dir = tmpSkillsDir()
  writeSkill(dir, 'a', `---\nname: a\n---\n`)
  writeSkill(
    dir,
    'd',
    `---\nname: d\n---\n# D\nSee [[a]] for context.\n`,
  )
  const g = await buildGraph(dir)
  const linkEdge = g.edges.find((e) => e.kind === 'link' && e.source === 'd' && e.target === 'a')
  assert.ok(linkEdge)
})

test('buildGraph: dangling wikilink becomes a diagnostic, not an edge', async () => {
  const dir = tmpSkillsDir()
  writeSkill(dir, 'd', `---\nname: d\n---\nSee [[ghost]] which doesn't exist.\n`)
  const g = await buildGraph(dir)
  // No edge to 'ghost'.
  assert.equal(g.edges.length, 0)
  // Diagnostic warning surfaced.
  const diag = g.diagnostics.find((d) => d.message.includes('ghost'))
  assert.ok(diag)
  assert.equal(diag.severity, 'warn')
})

test('buildGraph: wikilink inside a fenced code block is ignored', async () => {
  const dir = tmpSkillsDir()
  writeSkill(dir, 'a', `---\nname: a\n---\n`)
  writeSkill(
    dir,
    'd',
    `---\nname: d\n---\n# D\nThe syntax is:\n\n\`\`\`\nuse [[a]] inline\n\`\`\`\n`,
  )
  const g = await buildGraph(dir)
  // The wikilink in the code block must NOT produce a link edge.
  assert.equal(g.edges.length, 0)
  // And no dangling-link diagnostic either, since it was inside code.
  assert.equal(g.diagnostics.length, 0)
})

test('buildGraph: dangling uses becomes a diagnostic, not an edge', async () => {
  const dir = tmpSkillsDir()
  writeSkill(dir, 'b', `---\nname: b\nuses:\n  - nonexistent\n---\n`)
  const g = await buildGraph(dir)
  assert.equal(g.edges.length, 0)
  const diag = g.diagnostics.find((d) => d.message.includes('nonexistent'))
  assert.ok(diag)
  assert.equal(diag.severity, 'warn')
})

test('buildGraph: missing skillsDir returns empty graph (not an error)', async () => {
  const g = await buildGraph('/no/such/dir/at/all')
  assert.deepStrictEqual(g, { nodes: [], edges: [], diagnostics: [] })
})

test('buildGraph: directory with no SKILL.md emits a warn diagnostic', async () => {
  const dir = tmpSkillsDir()
  fs.mkdirSync(path.join(dir, 'empty-skill'), { recursive: true })
  const g = await buildGraph(dir)
  assert.equal(g.nodes.length, 0)
  const diag = g.diagnostics.find((d) => d.message.includes('no SKILL.md'))
  assert.ok(diag)
  assert.equal(diag.severity, 'warn')
})

test('buildGraph: duplicate uses entries collapse to one edge', async () => {
  const dir = tmpSkillsDir()
  writeSkill(dir, 'a', `---\nname: a\n---\n`)
  writeSkill(dir, 'b', `---\nname: b\nuses:\n  - a\n  - a\n---\n`)
  const g = await buildGraph(dir)
  const edges = g.edges.filter((e) => e.kind === 'uses' && e.target === 'a')
  assert.equal(edges.length, 1)
})

// ---- parser accepted-shape tests: every documented shape stays accepted as
// the parser's strict mode evolves. These guard against future tightening
// accidentally rejecting a shape skill authors are already writing.

// Each entry: [label, frontmatter content, expected node id, expected partial fields]
const PARSER_OK = [
  ['quoted scalar', `---\nname: "alpha"\ndescription: 'first one'\n---\n`, 'alpha', { description: 'first one' }],
  ['inline empty array', `---\nname: a\ntags: []\n---\n`, 'a', { tags: [] }],
  ['inline array with items', `---\nname: a\ntags: [foo, bar]\n---\n`, 'a', { tags: ['foo', 'bar'] }],
  ['block array (uses)', `---\nname: a\nuses:\n  - first\n  - second\n---\n`, 'a', {}],
]

for (const [label, content, expectedId, expected] of PARSER_OK) {
  test(`parser accepts: ${label}`, async () => {
    const dir = tmpSkillsDir()
    // Use the directory name "a" so paths are stable; the skill's `name`
    // (the node id) comes from frontmatter.
    writeSkill(dir, 'a', content)
    const g = await buildGraph(dir)
    // Parsing succeeded → node exists. We don't assert diagnostics empty
    // because some shapes legally produce them (e.g. dangling uses).
    const node = g.nodes.find((n) => n.id === expectedId)
    assert.ok(node, `expected node '${expectedId}' for shape ${label}; diagnostics: ${JSON.stringify(g.diagnostics)}`)
    // No PARSE-error diagnostics for the source file.
    const parseErrors = g.diagnostics.filter(
      (d) => d.severity === 'error' && d.path === 'a/SKILL.md',
    )
    assert.deepStrictEqual(parseErrors, [], `unexpected parse errors for shape ${label}`)
    if (expected.description !== undefined) assert.equal(node.description, expected.description)
    if (expected.tags !== undefined) assert.deepStrictEqual(node.tags, expected.tags)
  })
}

// ---- parser strictness tests (cover the new diagnostic paths added in
// response to Codex round 1: malformed inline arrays, inline objects, etc.)

const PARSER_FAIL = [
  // [label, frontmatter content, expected message substring]
  ['malformed inline array (missing close bracket)', `---\nname: a\nuses: [foo\n---\n`, 'unbalanced inline array'],
  ['inline object', `---\nname: a\nmeta: {x: 1}\n---\n`, 'inline objects'],
  ['unexpected indent at top level', `---\nname: a\n  description: nested\n---\n`, 'unexpected indent'],
  ['empty inline-array item', `---\nname: a\nuses: [foo, ]\n---\n`, 'empty inline-array'],
]

for (const [label, content, expected] of PARSER_FAIL) {
  test(`parser: rejects ${label}`, async () => {
    const dir = tmpSkillsDir()
    writeSkill(dir, 'broken', content)
    const g = await buildGraph(dir)
    assert.equal(g.nodes.length, 0)
    const diag = g.diagnostics.find((d) => d.message.includes(expected))
    assert.ok(diag, `expected diagnostic mentioning "${expected}", got ${JSON.stringify(g.diagnostics)}`)
  })
}

test('skillNameForPath extracts skill name from path', () => {
  const skillsDir = '/x/y'
  assert.equal(skillNameForPath(skillsDir, '/x/y/foo/SKILL.md'), 'foo')
  assert.equal(skillNameForPath(skillsDir, '/x/y/foo/sub/file'), 'foo')
  // outside skillsDir
  assert.equal(skillNameForPath(skillsDir, '/x/z/foo/SKILL.md'), null)
})
