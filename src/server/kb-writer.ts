import fs from 'node:fs/promises'
import path from 'node:path'

import {
  renderFrontmatter,
  SKILL_NAME_RE,
  MAX_BODY_CHARS,
  SkillWriteError,
} from './skills-writer.js'

/**
 * Generalized atomic writer that powers skills, agents, and workflows.
 * Memory files use a separate writer because they have no frontmatter.
 *
 * - Reservation: non-recursive `mkdir(<kind>/<name>)` (EEXIST → SKILL_EXISTS).
 * - Write: tmp → rename in the entity's directory.
 * - Atomicity: at most one .tmp file lingers, swept on success.
 *
 * Use `writeKbFile` for new entities (rejects existing).
 * Use `updateKbFile` to merge-update an existing entity (404s if missing).
 */

export type KbWriteKind = 'skills' | 'agents' | 'workflows' | 'souls'
export const FILENAME_BY_KIND: Record<KbWriteKind, string> = {
  skills: 'SKILL.md',
  agents: 'AGENT.md',
  workflows: 'WORKFLOW.md',
  souls: 'SOUL.md',
}

export interface WriteKbFileInput {
  kind: KbWriteKind
  name: string
  body?: string
  /** Object form of YAML frontmatter. The writer always overrides `name`. */
  frontmatter?: Record<string, unknown>
}

export interface WriteKbFileResult {
  /** Path relative to kbRoot, e.g. "skills/foo/SKILL.md". */
  relPath: string
  /** Absolute path on disk. */
  absPath: string
}

function checkName(name: string, code: 'INVALID_SKILL_NAME' | 'INVALID_AGENT_NAME' | 'INVALID_WORKFLOW_NAME' | 'INVALID_SOUL_NAME'): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw new SkillWriteError(code, `name must match ${SKILL_NAME_RE}; got ${JSON.stringify(name)}`)
  }
}

function checkBody(body: string): void {
  if (body.length > MAX_BODY_CHARS) {
    throw new SkillWriteError('BODY_TOO_LARGE', `content exceeds ${MAX_BODY_CHARS} characters`)
  }
}

function nameErrorCodeFor(kind: KbWriteKind): 'INVALID_SKILL_NAME' | 'INVALID_AGENT_NAME' | 'INVALID_WORKFLOW_NAME' | 'INVALID_SOUL_NAME' {
  return kind === 'skills' ? 'INVALID_SKILL_NAME'
    : kind === 'agents' ? 'INVALID_AGENT_NAME'
    : kind === 'souls' ? 'INVALID_SOUL_NAME'
    : 'INVALID_WORKFLOW_NAME'
}

function existsErrorCodeFor(kind: KbWriteKind): 'SKILL_EXISTS' | 'AGENT_EXISTS' | 'WORKFLOW_EXISTS' | 'SOUL_EXISTS' {
  return kind === 'skills' ? 'SKILL_EXISTS'
    : kind === 'agents' ? 'AGENT_EXISTS'
    : kind === 'souls' ? 'SOUL_EXISTS'
    : 'WORKFLOW_EXISTS'
}

function unknownErrorCodeFor(kind: KbWriteKind): 'UNKNOWN_SKILL' | 'UNKNOWN_AGENT' | 'UNKNOWN_WORKFLOW' | 'UNKNOWN_SOUL' {
  return kind === 'skills' ? 'UNKNOWN_SKILL'
    : kind === 'agents' ? 'UNKNOWN_AGENT'
    : kind === 'souls' ? 'UNKNOWN_SOUL'
    : 'UNKNOWN_WORKFLOW'
}

/** Create a new entity. Throws *_EXISTS if it already exists. */
export async function writeKbFile(kbRoot: string, input: WriteKbFileInput): Promise<WriteKbFileResult> {
  checkName(input.name, nameErrorCodeFor(input.kind))
  const body = input.body ?? ''
  checkBody(body)
  // Render frontmatter early so a validation failure doesn't leave a stray dir.
  const fmText = renderFrontmatter({ ...(input.frontmatter ?? {}), name: input.name })
  const fileText = `---\n${fmText}---\n${body}`

  const subdir = path.join(kbRoot, input.kind)
  const dir = path.join(subdir, input.name)
  const fileName = FILENAME_BY_KIND[input.kind]
  const absPath = path.join(dir, fileName)
  const tmpPath = `${absPath}.tmp.${process.pid}.${Date.now()}`

  await fs.mkdir(subdir, { recursive: true })

  // Atomic reservation.
  try {
    await fs.mkdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new SkillWriteError(existsErrorCodeFor(input.kind) as 'SKILL_EXISTS', `${input.kind}/${input.name} already exists`)
    }
    throw new SkillWriteError('INTERNAL', `mkdir failed: ${(err as Error).message}`)
  }

  try {
    await fs.writeFile(tmpPath, fileText)
    await fs.rename(tmpPath, absPath)
  } catch (err) {
    try {
      await fs.unlink(tmpPath).catch(() => undefined)
      const exists = await fs.stat(absPath).then(() => true).catch(() => false)
      if (!exists) await fs.rmdir(dir).catch(() => undefined)
    } catch {
      // ignore
    }
    throw new SkillWriteError('INTERNAL', `write failed: ${(err as Error).message}`)
  }

  // Best-effort sweep of stale tmp files from prior crashes.
  try {
    const entries = await fs.readdir(dir)
    const tmpName = path.basename(tmpPath)
    for (const e of entries) {
      if (e.startsWith(`${fileName}.tmp.`) && e !== tmpName) {
        await fs.unlink(path.join(dir, e)).catch(() => undefined)
      }
    }
  } catch {
    // ignore
  }

  return {
    relPath: path.posix.join(input.kind, input.name, fileName),
    absPath,
  }
}

/**
 * Update an existing entity. 404s if it doesn't exist. Merges:
 *  - omitted body → existing body kept
 *  - omitted frontmatter → existing frontmatter kept
 *  - provided frontmatter → REPLACES prior, except `name` which is locked
 *
 * The writer accepts the parsed prior frontmatter object (caller does the
 * read so this module stays I/O-light for testing).
 */
export interface UpdateKbFileInput {
  kind: KbWriteKind
  name: string
  body?: string
  /** When provided, replaces existing frontmatter (except `name`). */
  frontmatter?: Record<string, unknown>
  /**
   * Existing frontmatter on disk — caller reads + parses + passes in. Used
   * when the request omits `frontmatter` so we preserve what's there. The
   * writer always overrides the `name` field with `input.name`.
   */
  existingFrontmatter: Record<string, unknown>
  /** Existing body on disk — used when the request omits `body`. */
  existingBody: string
}

export async function updateKbFile(kbRoot: string, input: UpdateKbFileInput): Promise<WriteKbFileResult> {
  checkName(input.name, nameErrorCodeFor(input.kind))
  const body = input.body !== undefined ? input.body : input.existingBody
  checkBody(body)
  const merged = input.frontmatter !== undefined
    ? { ...input.frontmatter, name: input.name }
    : { ...input.existingFrontmatter, name: input.name }
  const fmText = renderFrontmatter(merged)
  const fileText = `---\n${fmText}---\n${body}`

  const fileName = FILENAME_BY_KIND[input.kind]
  const dir = path.join(kbRoot, input.kind, input.name)
  const absPath = path.join(dir, fileName)
  const tmpPath = `${absPath}.tmp.${process.pid}.${Date.now()}`

  // 404 if missing.
  try {
    await fs.stat(absPath)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new SkillWriteError(unknownErrorCodeFor(input.kind) as 'UNKNOWN_SKILL', `${input.kind}/${input.name} does not exist`)
    }
    throw new SkillWriteError('INTERNAL', `stat failed: ${(err as Error).message}`)
  }

  try {
    await fs.writeFile(tmpPath, fileText)
    await fs.rename(tmpPath, absPath)
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined)
    throw new SkillWriteError('INTERNAL', `write failed: ${(err as Error).message}`)
  }

  return {
    relPath: path.posix.join(input.kind, input.name, fileName),
    absPath,
  }
}

/** Read+parse an existing entity. 404s if missing. */
export async function readKbFile(
  kbRoot: string,
  kind: KbWriteKind,
  name: string,
): Promise<{ frontmatter: Record<string, unknown>; body: string; relPath: string }> {
  checkName(name, nameErrorCodeFor(kind))
  const fileName = FILENAME_BY_KIND[kind]
  const relPath = path.posix.join(kind, name, fileName)
  const absPath = path.join(kbRoot, kind, name, fileName)
  let raw: string
  try {
    raw = await fs.readFile(absPath, 'utf8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new SkillWriteError(unknownErrorCodeFor(kind) as 'UNKNOWN_SKILL', `${kind}/${name} does not exist`)
    }
    throw new SkillWriteError('INTERNAL', `read failed: ${(err as Error).message}`)
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (!m) {
    throw new SkillWriteError('INTERNAL', `${relPath} has no YAML frontmatter`)
  }
  const fmRaw = (m[1] ?? '') as string
  const body = (m[2] ?? '') as string
  const frontmatter = parseShallowFrontmatter(fmRaw)
  return { frontmatter, body, relPath }
}

/** Same shallow parser used by /api/kb/skill/:name; handles scalar + inline/block array. */
function parseShallowFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = raw.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim().length === 0) { i++; continue }
    if (/^\s/.test(line)) { i++; continue }
    const colon = line.indexOf(':')
    if (colon < 0) { i++; continue }
    const key = line.slice(0, colon).trim()
    const after = line.slice(colon + 1).trim()
    if (after.length === 0) {
      const items: string[] = []
      i++
      while (i < lines.length && /^\s/.test(lines[i] ?? '')) {
        const m = /^\s+-\s*(.*)$/.exec(lines[i] ?? '')
        if (m) items.push(stripQuotes((m[1] ?? '').trim()))
        i++
      }
      out[key] = items
      continue
    }
    if (after.startsWith('[') && after.endsWith(']')) {
      const inner = after.slice(1, -1).trim()
      out[key] = inner.length === 0 ? [] : inner.split(',').map((s) => stripQuotes(s.trim()))
      i++
      continue
    }
    out[key] = stripQuotes(after)
    i++
  }
  return out
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  return s
}

/** List entity names by reading dir entries; entries that don't have the expected file are filtered out. */
export async function listKbEntities(kbRoot: string, kind: KbWriteKind): Promise<string[]> {
  const subdir = path.join(kbRoot, kind)
  let entries: string[]
  try {
    entries = await fs.readdir(subdir)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw err
  }
  const fileName = FILENAME_BY_KIND[kind]
  const out: string[] = []
  for (const e of entries) {
    const candidate = path.join(subdir, e, fileName)
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile() && SKILL_NAME_RE.test(e)) out.push(e)
    } catch {
      // skip non-conforming dirs
    }
  }
  return out.sort()
}
