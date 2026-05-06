import type { IncomingMessage, ServerResponse } from 'node:http'

import { jsonError, jsonOk, matchPath, parsePath, readJsonBody } from '../server/http-helpers.js'
import { writeSoul, patchSoul, readSoul, listSouls } from '../server/soul-writer.js'
import { SkillWriteError, SKILL_NAME_RE } from '../server/skills-writer.js'
import type { Wiring } from '../server/wiring.js'

export const SOULS_PATH = '/api/souls'
export const SOULS_DETAIL_PATTERN = '/api/souls/:name'

export async function handleSoulsList(_req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  try {
    const names = await listSouls(w.kbRoot)
    const souls: Array<{ name: string; description?: string }> = []
    for (const n of names) {
      try {
        const s = await readSoul(w.kbRoot, n)
        const fm = s.frontmatter
        const entry: { name: string; description?: string } = { name: n }
        if (typeof fm.description === 'string') entry.description = fm.description
        souls.push(entry)
      } catch { /* skip unreadable */ }
    }
    jsonOk(res, 200, { souls })
  } catch (err) {
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}

export async function handleSoulsCreate(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  let body: unknown
  try { body = await readJsonBody(req) } catch (err) {
    jsonError(res, 400, 'BAD_REQUEST', (err as Error).message); return
  }
  if (!body || typeof body !== 'object') {
    jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object'); return
  }
  const obj = body as Record<string, unknown>
  if (typeof obj.name !== 'string') {
    jsonError(res, 400, 'INVALID_SOUL_NAME', 'name must be a string'); return
  }
  try {
    const result = await writeSoul(w.kbRoot, {
      name: obj.name,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      values: Array.isArray(obj.values) ? (obj.values.filter((v) => typeof v === 'string') as string[]) : undefined,
      priorities: Array.isArray(obj.priorities) ? (obj.priorities.filter((v) => typeof v === 'string') as string[]) : undefined,
      risk_tolerance: typeof obj.risk_tolerance === 'string' ? obj.risk_tolerance : undefined,
      decision_principles: Array.isArray(obj.decision_principles) ? (obj.decision_principles.filter((v) => typeof v === 'string') as string[]) : undefined,
      tone: typeof obj.tone === 'string' ? obj.tone : undefined,
      model_preference: typeof obj.model_preference === 'string' ? obj.model_preference : undefined,
      body: typeof obj.body === 'string' ? obj.body : undefined,
    })
    jsonOk(res, 201, { name: obj.name, path: result.relPath })
  } catch (err) { handleErr(res, err) }
}

export async function handleSoulsRead(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(SOULS_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.name) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown souls detail path'); return
  }
  const name: string = params.name
  if (!SKILL_NAME_RE.test(name)) {
    jsonError(res, 400, 'INVALID_SOUL_NAME', `name must match ${SKILL_NAME_RE}`); return
  }
  try {
    const s = await readSoul(w.kbRoot, name)
    jsonOk(res, 200, { name, frontmatter: s.frontmatter, body: s.body, path: s.relPath })
  } catch (err) { handleErr(res, err) }
}

export async function handleSoulsUpdate(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(SOULS_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.name) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown souls detail path'); return
  }
  const name: string = params.name
  if (!SKILL_NAME_RE.test(name)) {
    jsonError(res, 400, 'INVALID_SOUL_NAME', `name must match ${SKILL_NAME_RE}`); return
  }
  let body: unknown
  try { body = await readJsonBody(req) } catch (err) {
    jsonError(res, 400, 'BAD_REQUEST', (err as Error).message); return
  }
  if (!body || typeof body !== 'object') {
    jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object'); return
  }
  const obj = body as Record<string, unknown>
  try {
    const result = await patchSoul(w.kbRoot, name, {
      description: typeof obj.description === 'string' ? obj.description : undefined,
      values: Array.isArray(obj.values) ? (obj.values.filter((v) => typeof v === 'string') as string[]) : undefined,
      priorities: Array.isArray(obj.priorities) ? (obj.priorities.filter((v) => typeof v === 'string') as string[]) : undefined,
      risk_tolerance: typeof obj.risk_tolerance === 'string' ? obj.risk_tolerance : undefined,
      decision_principles: Array.isArray(obj.decision_principles) ? (obj.decision_principles.filter((v) => typeof v === 'string') as string[]) : undefined,
      tone: typeof obj.tone === 'string' ? obj.tone : undefined,
      model_preference: typeof obj.model_preference === 'string' ? obj.model_preference : undefined,
      body: typeof obj.body === 'string' ? obj.body : undefined,
    })
    jsonOk(res, 200, { name, path: result.relPath })
  } catch (err) { handleErr(res, err) }
}

function handleErr(res: ServerResponse, err: unknown): void {
  if (err instanceof SkillWriteError) {
    const status =
      err.code === 'INVALID_SOUL_NAME' ? 400
      : err.code === 'INVALID_FRONTMATTER' ? 400
      : err.code === 'BODY_TOO_LARGE' ? 400
      : err.code === 'SOUL_EXISTS' ? 409
      : err.code === 'UNKNOWN_SOUL' ? 404
      : 500
    jsonError(res, status, err.code, err.message)
    return
  }
  jsonError(res, 500, 'INTERNAL', (err as Error).message)
}
