import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  jsonError,
  jsonOk,
  matchPath,
  parsePath,
  readJsonBody,
} from '../server/http-helpers.js'
import type { Wiring } from '../server/wiring.js'
import {
  writeSkill,
  SkillWriteError,
  SKILL_NAME_RE,
} from '../server/skills-writer.js'

export const SKILLS_CREATE_PATH = '/api/skills'
export const KB_SKILL_GET_PATTERN = '/api/kb/skill/:name'

export async function handleSkillsCreate(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    const code = (err as Error & { code?: string }).code ?? 'BAD_REQUEST'
    jsonError(res, 400, code, (err as Error).message)
    return
  }
  if (!body || typeof body !== 'object') {
    jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object')
    return
  }
  const { name, content, frontmatter } = body as Record<string, unknown>
  if (typeof name !== 'string') {
    jsonError(res, 400, 'INVALID_SKILL_NAME', 'name must be a string', { received: typeof name })
    return
  }
  if (content !== undefined && typeof content !== 'string') {
    jsonError(res, 400, 'BAD_REQUEST', 'content must be a string when provided')
    return
  }
  if (frontmatter !== undefined && (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter))) {
    jsonError(res, 400, 'BAD_REQUEST', 'frontmatter must be a JSON object when provided')
    return
  }
  try {
    const result = await writeSkill(w.skillsDir, {
      name,
      content: content as string | undefined,
      frontmatter: frontmatter as Record<string, unknown> | undefined,
    })
    jsonOk(res, 201, { name, path: result.relPath })
  } catch (err) {
    if (err instanceof SkillWriteError) {
      const status = err.code === 'INVALID_SKILL_NAME' ? 400
        : err.code === 'INVALID_FRONTMATTER' ? 400
        : err.code === 'BODY_TOO_LARGE' ? 400
        : err.code === 'SKILL_EXISTS' ? 409
        : 500
      jsonError(res, status, err.code, err.message)
      return
    }
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}

export async function handleKbSkillGet(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  const params = matchPath(KB_SKILL_GET_PATTERN, parsePath(req.url))
  if (!params || !params.name) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown kb skill path')
    return
  }
  const name: string = params.name
  if (!SKILL_NAME_RE.test(name)) {
    jsonError(res, 400, 'INVALID_SKILL_NAME', `name must match ${SKILL_NAME_RE}`)
    return
  }
  const relPath = `${name}/SKILL.md`
  const absPath = path.join(w.skillsDir, relPath)
  let raw: string
  try {
    raw = await fs.readFile(absPath, 'utf8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      jsonError(res, 404, 'UNKNOWN_SKILL', `skill ${name} does not exist`)
      return
    }
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
    return
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (!m) {
    jsonError(res, 500, 'CORRUPT_SKILL', 'skill file has no frontmatter')
    return
  }
  const fmRaw = m[1] as string
  const fmBody = (m[2] ?? '') as string
  const frontmatter = parseFrontmatterShallow(fmRaw)
  jsonOk(res, 200, { name, frontmatter, body: fmBody, path: relPath })
}

/**
 * Tiny line-oriented parser tolerant enough for kb consumers reading what we
 * just wrote. Mirrors the strict shapes from kb-browser without the diagnostic
 * machinery — this is just a JSON projection for clients.
 */
function parseFrontmatterShallow(raw: string): Record<string, unknown> {
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
      i++
      continue
    }
    const colon = line.indexOf(':')
    if (colon < 0) { i++; continue }
    const key = line.slice(0, colon).trim()
    const after = line.slice(colon + 1).trim()
    if (after.length === 0) {
      const items: string[] = []
      i++
      while (i < lines.length && /^\s/.test(lines[i] ?? '')) {
        const m = /^\s+-\s*(.*)$/.exec(lines[i] ?? '')
        if (m) items.push(strip(m[1] ?? ''))
        i++
      }
      out[key] = items
      continue
    }
    if (after.startsWith('[') && after.endsWith(']')) {
      const inner = after.slice(1, -1).trim()
      out[key] = inner.length === 0 ? [] : inner.split(',').map((s) => strip(s.trim()))
      i++
      continue
    }
    out[key] = strip(after)
    i++
  }
  return out
}

function strip(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  return s
}
