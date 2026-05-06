import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  jsonError,
  jsonOk,
  matchPath,
  parsePath,
  readJsonBody,
} from '../server/http-helpers.js'
import type { Wiring } from '../server/wiring.js'
import { writeAgent, patchAgent, readAgent, listAgents } from '../server/agent-writer.js'
import { listKbEntities } from '../server/kb-writer.js'
import { SkillWriteError } from '../server/skills-writer.js'
import { SKILL_NAME_RE } from '../server/skills-writer.js'

export const AGENTS_PATH = '/api/agents'
export const AGENTS_DETAIL_PATTERN = '/api/agents/:name'

export async function handleAgentsList(_req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  try {
    const names = await listAgents(w.kbRoot)
    const agents: Array<{ name: string; description?: string; skills: string[] }> = []
    for (const n of names) {
      try {
        const a = await readAgent(w.kbRoot, n)
        const fm = a.frontmatter
        const skills = Array.isArray(fm.skills)
          ? (fm.skills as unknown[]).filter((x) => typeof x === 'string') as string[]
          : []
        const entry: { name: string; description?: string; skills: string[] } = { name: n, skills }
        if (typeof fm.description === 'string') entry.description = fm.description
        agents.push(entry)
      } catch {
        // skip unreadable
      }
    }
    jsonOk(res, 200, { agents })
  } catch (err) {
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}

export async function handleAgentsCreate(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    jsonError(res, 400, 'BAD_REQUEST', (err as Error).message)
    return
  }
  if (!body || typeof body !== 'object') {
    jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object')
    return
  }
  const { name, description, skills, persona, soul } = body as Record<string, unknown>
  if (typeof name !== 'string') {
    jsonError(res, 400, 'INVALID_AGENT_NAME', 'name must be a string')
    return
  }
  if (description !== undefined && typeof description !== 'string') {
    jsonError(res, 400, 'BAD_REQUEST', 'description must be a string when provided')
    return
  }
  if (persona !== undefined && typeof persona !== 'string') {
    jsonError(res, 400, 'BAD_REQUEST', 'persona must be a string when provided')
    return
  }
  if (soul !== undefined && typeof soul !== 'string') {
    jsonError(res, 400, 'BAD_REQUEST', 'soul must be a string when provided')
    return
  }
  try {
    const knownSkills = new Set(await listKbEntities(w.kbRoot, 'skills'))
    const knownSouls = new Set(await listKbEntities(w.kbRoot, 'souls'))
    const result = await writeAgent(
      w.kbRoot,
      {
        name,
        description: description as string | undefined,
        skills: skills as string[],
        persona: persona as string | undefined,
        soul: soul as string | undefined,
      },
      knownSkills,
      knownSouls,
    )
    jsonOk(res, 201, { name, path: result.relPath })
  } catch (err) {
    handleWriteError(res, err)
  }
}

export async function handleAgentsRead(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(AGENTS_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.name) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown agents detail path')
    return
  }
  const name: string = params.name
  if (!SKILL_NAME_RE.test(name)) {
    jsonError(res, 400, 'INVALID_AGENT_NAME', `name must match ${SKILL_NAME_RE}`)
    return
  }
  try {
    const a = await readAgent(w.kbRoot, name)
    jsonOk(res, 200, { name, frontmatter: a.frontmatter, body: a.body, path: a.relPath })
  } catch (err) {
    handleWriteError(res, err)
  }
}

export async function handleAgentsUpdate(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(AGENTS_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.name) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown agents detail path')
    return
  }
  const name: string = params.name
  if (!SKILL_NAME_RE.test(name)) {
    jsonError(res, 400, 'INVALID_AGENT_NAME', `name must match ${SKILL_NAME_RE}`)
    return
  }
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    jsonError(res, 400, 'BAD_REQUEST', (err as Error).message)
    return
  }
  if (!body || typeof body !== 'object') {
    jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object')
    return
  }
  const { description, skills, persona, soul } = body as Record<string, unknown>
  try {
    const knownSkills = new Set(await listKbEntities(w.kbRoot, 'skills'))
    const knownSouls = new Set(await listKbEntities(w.kbRoot, 'souls'))
    const result = await patchAgent(
      w.kbRoot,
      name,
      {
        description: description as string | undefined,
        skills: skills as string[] | undefined,
        persona: persona as string | undefined,
        soul: soul as string | undefined,
      },
      knownSkills,
      knownSouls,
    )
    jsonOk(res, 200, { name, path: result.relPath })
  } catch (err) {
    handleWriteError(res, err)
  }
}

function handleWriteError(res: ServerResponse, err: unknown): void {
  if (err instanceof SkillWriteError) {
    const status =
      err.code === 'INVALID_AGENT_NAME' ? 400
      : err.code === 'INVALID_AGENT_SKILLS' ? 400
      : err.code === 'INVALID_FRONTMATTER' ? 400
      : err.code === 'BODY_TOO_LARGE' ? 400
      : err.code === 'UNKNOWN_SOUL' ? 400
      : err.code === 'AGENT_EXISTS' ? 409
      : err.code === 'UNKNOWN_AGENT' ? 404
      : 500
    const details = (err as Error & { details?: Record<string, unknown> }).details
    jsonError(res, status, err.code, err.message, details)
    return
  }
  jsonError(res, 500, 'INTERNAL', (err as Error).message)
}
