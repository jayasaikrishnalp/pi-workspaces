import fs from 'node:fs/promises'
import path from 'node:path'

import type { Diagnostic, KbGraph, SkillEdge, SkillNode } from '../types/kb.js'

interface ParsedSkill {
  /** SKILL.md path relative to skillsDir. */
  relPath: string
  frontmatter: Record<string, unknown>
  body: string
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/

const WIKILINK_RE = /\[\[([a-zA-Z0-9_-]+)\]\]/g
const FENCED_CODE_RE = /```[\s\S]*?```/g

/**
 * Walk skillsDir, parse every <name>/SKILL.md into a graph.
 * Stateless — every call re-walks. ≤500 skills runs in <50ms warm.
 */
export async function buildGraph(skillsDir: string): Promise<KbGraph> {
  const nodes: SkillNode[] = []
  const edges: SkillEdge[] = []
  const diagnostics: Diagnostic[] = []
  const knownIds = new Set<string>()

  let entries: string[] = []
  try {
    entries = await fs.readdir(skillsDir)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // No skills dir yet — empty graph, no diagnostics.
      return { nodes: [], edges: [], diagnostics: [] }
    }
    throw err
  }

  // First pass: parse and collect nodes.
  const parsed: ParsedSkill[] = []
  for (const entry of entries) {
    const dir = path.join(skillsDir, entry)
    let stat
    try {
      stat = await fs.stat(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    const skillPath = path.join(dir, 'SKILL.md')
    const relPath = path.relative(skillsDir, skillPath)
    let raw: string
    try {
      raw = await fs.readFile(skillPath, 'utf8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        diagnostics.push({
          path: relPath,
          severity: 'warn',
          message: `directory ${entry}/ has no SKILL.md`,
        })
        continue
      }
      throw err
    }

    const m = FRONTMATTER_RE.exec(raw)
    if (!m) {
      diagnostics.push({
        path: relPath,
        severity: 'error',
        message: 'no YAML frontmatter (expected leading `---` and trailing `---` lines)',
      })
      continue
    }
    const frontmatterRaw = m[1] as string
    const body = (m[2] ?? '') as string

    let frontmatter: Record<string, unknown>
    try {
      frontmatter = parseSimpleFrontmatter(frontmatterRaw)
    } catch (err) {
      diagnostics.push({
        path: relPath,
        severity: 'error',
        message: `frontmatter parse failed: ${(err as Error).message}`,
      })
      continue
    }

    if (typeof frontmatter.name !== 'string' || frontmatter.name.length === 0) {
      diagnostics.push({
        path: relPath,
        severity: 'error',
        message: 'missing required `name` field',
      })
      continue
    }
    parsed.push({ relPath, frontmatter, body })
    knownIds.add(frontmatter.name)
  }

  // Second pass: build nodes + edges, validating cross-references.
  for (const p of parsed) {
    const id = p.frontmatter.name as string
    const node: SkillNode = {
      id,
      name: id,
      path: p.relPath,
      source: 'skill',
    }
    if (typeof p.frontmatter.description === 'string') {
      node.description = p.frontmatter.description
    }
    if (Array.isArray(p.frontmatter.tags)) {
      node.tags = p.frontmatter.tags.filter((t) => typeof t === 'string') as string[]
    }
    nodes.push(node)

    const seenEdges = new Set<string>()
    const pushEdge = (target: string, kind: 'uses' | 'link') => {
      const key = `${id}|${target}|${kind}`
      if (seenEdges.has(key)) return
      seenEdges.add(key)
      edges.push({ source: id, target, kind })
    }

    if (Array.isArray(p.frontmatter.uses)) {
      for (const u of p.frontmatter.uses) {
        if (typeof u !== 'string') continue
        if (!knownIds.has(u)) {
          diagnostics.push({
            path: p.relPath,
            severity: 'warn',
            message: `\`uses\` references unknown skill "${u}"`,
          })
          continue
        }
        pushEdge(u, 'uses')
      }
    }

    // Strip fenced code blocks so wikilinks inside code samples don't create edges.
    const bodyNoCode = p.body.replace(FENCED_CODE_RE, '')
    let match: RegExpExecArray | null
    while ((match = WIKILINK_RE.exec(bodyNoCode)) !== null) {
      const ref = match[1] as string
      if (!knownIds.has(ref)) {
        diagnostics.push({
          path: p.relPath,
          severity: 'warn',
          message: `body wikilink \`[[${ref}]]\` does not match any known skill`,
        })
        continue
      }
      pushEdge(ref, 'link')
    }
  }

  return { nodes, edges, diagnostics }
}

/**
 * Tiny line-oriented parser. Supports:
 *   key: value           (string scalar — value is trimmed; quotes optional)
 *   key: [a, b, c]       (inline array — string elements)
 *   key:                 (block array)
 *     - item
 *     - item
 *
 * Anything richer (multiline strings, nested objects, anchors) throws —
 * skill authors should keep frontmatter shallow.
 */
function parseSimpleFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = raw.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim().length === 0) {
      i++
      continue
    }
    if (/^\s/.test(line)) {
      throw new Error(`unexpected indent at line ${i + 1}: ${line}`)
    }
    const colon = line.indexOf(':')
    if (colon < 0) {
      throw new Error(`expected \`key: value\` at line ${i + 1}: ${line}`)
    }
    const key = line.slice(0, colon).trim()
    const after = line.slice(colon + 1).trim()
    if (after.length === 0) {
      // Block array follows.
      const items: unknown[] = []
      i++
      while (i < lines.length && /^\s/.test(lines[i] ?? '')) {
        const item = lines[i] ?? ''
        const m = /^\s+-\s*(.*)$/.exec(item)
        if (!m) throw new Error(`expected \`- item\` at line ${i + 1}: ${item}`)
        items.push(stripQuotes((m[1] ?? '').trim()))
        i++
      }
      out[key] = items
      continue
    }
    // Inline array. Both brackets must be present, and items must be non-empty strings.
    if (after.startsWith('[') || after.endsWith(']')) {
      if (!(after.startsWith('[') && after.endsWith(']'))) {
        throw new Error(`unbalanced inline array at line ${i + 1}: ${line}`)
      }
      const inner = after.slice(1, -1).trim()
      const items = inner.length === 0 ? [] : inner.split(',').map((s) => stripQuotes(s.trim()))
      for (const item of items) {
        if (typeof item !== 'string' || item.length === 0) {
          throw new Error(`empty inline-array item at line ${i + 1}: ${line}`)
        }
      }
      out[key] = items
      i++
      continue
    }
    // Inline object / unsupported nested YAML.
    if (after.startsWith('{')) {
      throw new Error(`inline objects are not supported at line ${i + 1}: ${line}`)
    }
    // Tagged or anchored values reach beyond this parser's contract.
    if (after.startsWith('!') || after.startsWith('&') || after.startsWith('*')) {
      throw new Error(`anchor/tag/alias is not supported at line ${i + 1}: ${line}`)
    }
    out[key] = stripQuotes(after)
    i++
  }
  return out
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

/** Extract the skill name from an absolute path under skillsDir, if applicable. */
export function skillNameForPath(skillsDir: string, absPath: string): string | null {
  const rel = path.relative(skillsDir, absPath)
  if (rel.startsWith('..')) return null
  // Skill files live at <skillsDir>/<name>/SKILL.md. Anything else returns null.
  const segments = rel.split(path.sep)
  if (segments.length < 2) return null
  return segments[0] ?? null
}
