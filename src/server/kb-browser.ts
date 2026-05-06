import fs from 'node:fs/promises'
import path from 'node:path'

import type { Diagnostic, KbGraph, KbNodeKind, SkillEdge, SkillNode } from '../types/kb.js'
import { decodeSteps } from './workflow-writer.js'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/
const WIKILINK_RE = /\[\[([a-zA-Z0-9_-]+)\]\]/g
const FENCED_CODE_RE = /```[\s\S]*?```/g

const KIND_FILE: Record<KbNodeKind, string> = {
  skill: 'SKILL.md',
  agent: 'AGENT.md',
  workflow: 'WORKFLOW.md',
}

const KIND_SUBDIR: Record<KbNodeKind, string> = {
  skill: 'skills',
  agent: 'agents',
  workflow: 'workflows',
}

interface ParsedEntity {
  kind: KbNodeKind
  /** Path relative to kbRoot, e.g. "agents/sre-bot/AGENT.md". */
  relPath: string
  frontmatter: Record<string, unknown>
  body: string
}

/**
 * Walk all three KB kinds under kbRoot and produce a unified graph.
 *
 *   <kbRoot>/skills/<name>/SKILL.md
 *   <kbRoot>/agents/<name>/AGENT.md
 *   <kbRoot>/workflows/<name>/WORKFLOW.md
 *
 * Memory files (`<kbRoot>/memory/*.md`) are intentionally NOT walked — memory
 * is operator-owned text, separate from the entity graph.
 *
 * Stateless. ≤500 entities runs in <50ms warm.
 */
export async function buildGraph(kbRoot: string): Promise<KbGraph> {
  const nodes: SkillNode[] = []
  const edges: SkillEdge[] = []
  const diagnostics: Diagnostic[] = []
  const idsByKind: Record<KbNodeKind, Set<string>> = {
    skill: new Set(),
    agent: new Set(),
    workflow: new Set(),
  }

  // First pass: parse every entity, collect ids per kind.
  const parsed: ParsedEntity[] = []
  for (const kind of ['skill', 'agent', 'workflow'] as const) {
    const subdir = path.join(kbRoot, KIND_SUBDIR[kind])
    let dirEntries: string[]
    try {
      dirEntries = await fs.readdir(subdir)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      throw err
    }
    for (const entry of dirEntries) {
      const entityDir = path.join(subdir, entry)
      let stat
      try {
        stat = await fs.stat(entityDir)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      const fileName = KIND_FILE[kind]
      const filePath = path.join(entityDir, fileName)
      const relPath = path.posix.join(KIND_SUBDIR[kind], entry, fileName)
      let raw: string
      try {
        raw = await fs.readFile(filePath, 'utf8')
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          diagnostics.push({
            path: relPath,
            severity: 'warn',
            message: `directory ${KIND_SUBDIR[kind]}/${entry}/ has no ${fileName}`,
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
      parsed.push({ kind, relPath, frontmatter, body })
      idsByKind[kind].add(frontmatter.name as string)
    }
  }

  // Second pass: produce nodes + edges and validate cross-references.
  for (const p of parsed) {
    const id = p.frontmatter.name as string
    const node: SkillNode = { id, name: id, path: p.relPath, source: p.kind }
    if (typeof p.frontmatter.description === 'string') {
      node.description = p.frontmatter.description
    }
    if (Array.isArray(p.frontmatter.tags)) {
      node.tags = p.frontmatter.tags.filter((t) => typeof t === 'string') as string[]
    }
    nodes.push(node)

    const seenEdges = new Set<string>()
    const pushEdge = (target: string, kind: SkillEdge['kind']) => {
      const key = `${id}|${target}|${kind}`
      if (seenEdges.has(key)) return
      seenEdges.add(key)
      edges.push({ source: id, target, kind })
    }

    if (p.kind === 'skill') {
      // Skill: uses[] (frontmatter) + [[wikilinks]] in body.
      if (Array.isArray(p.frontmatter.uses)) {
        for (const u of p.frontmatter.uses) {
          if (typeof u !== 'string') continue
          if (!idsByKind.skill.has(u)) {
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
      const bodyNoCode = p.body.replace(FENCED_CODE_RE, '')
      let match: RegExpExecArray | null
      while ((match = WIKILINK_RE.exec(bodyNoCode)) !== null) {
        const ref = match[1] as string
        if (!idsByKind.skill.has(ref)) {
          diagnostics.push({
            path: p.relPath,
            severity: 'warn',
            message: `body wikilink \`[[${ref}]]\` does not match any known skill`,
          })
          continue
        }
        pushEdge(ref, 'link')
      }
    } else if (p.kind === 'agent') {
      // Agent: composes edges from skills[].
      if (Array.isArray(p.frontmatter.skills)) {
        for (const s of p.frontmatter.skills) {
          if (typeof s !== 'string') continue
          if (!idsByKind.skill.has(s)) {
            diagnostics.push({
              path: p.relPath,
              severity: 'warn',
              message: `\`skills\` references unknown skill "${s}"`,
            })
            continue
          }
          pushEdge(s, 'composes')
        }
      } else {
        diagnostics.push({
          path: p.relPath,
          severity: 'warn',
          message: 'agent missing required `skills` array',
        })
      }
    } else {
      // Workflow: step edges from steps[]. Steps are encoded as "<kind>:<ref>".
      const steps = decodeSteps(p.frontmatter.steps)
      if (steps.length === 0) {
        diagnostics.push({
          path: p.relPath,
          severity: 'warn',
          message: 'workflow missing or empty `steps` array',
        })
      }
      for (const step of steps) {
        const set = step.kind === 'skill' ? idsByKind.skill : idsByKind.workflow
        if (!set.has(step.ref)) {
          diagnostics.push({
            path: p.relPath,
            severity: 'warn',
            message: `step references unknown ${step.kind} "${step.ref}"`,
          })
          continue
        }
        pushEdge(step.ref, 'step')
      }
    }
  }

  return { nodes, edges, diagnostics }
}

function parseSimpleFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = raw.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim().length === 0) { i++; continue }
    if (/^\s/.test(line)) throw new Error(`unexpected indent at line ${i + 1}: ${line}`)
    const colon = line.indexOf(':')
    if (colon < 0) throw new Error(`expected \`key: value\` at line ${i + 1}: ${line}`)
    const key = line.slice(0, colon).trim()
    const after = line.slice(colon + 1).trim()
    if (after.length === 0) {
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
    if (after.startsWith('{')) throw new Error(`inline objects are not supported at line ${i + 1}: ${line}`)
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

/**
 * Extract the entity name from an absolute path under kbRoot, if applicable.
 *
 *   <kbRoot>/skills/<name>/SKILL.md   → "<name>"
 *   <kbRoot>/agents/<name>/AGENT.md   → "<name>"
 *   <kbRoot>/workflows/<name>/...     → "<name>"
 *   <kbRoot>/memory/<name>.md         → "<name>"
 *   anything else                     → null
 */
export function skillNameForPath(kbRoot: string, absPath: string): string | null {
  const rel = path.relative(kbRoot, absPath)
  if (rel.startsWith('..')) return null
  const segments = rel.split(path.sep)
  if (segments.length < 2) return null
  const subdir = segments[0]
  if (subdir === 'memory') {
    // For memory: <kbRoot>/memory/<name>.md → name without .md
    const last = segments[segments.length - 1] ?? ''
    if (last.endsWith('.md')) return last.slice(0, -3)
    return null
  }
  if (subdir === 'skills' || subdir === 'agents' || subdir === 'workflows') {
    return segments[1] ?? null
  }
  return null
}
