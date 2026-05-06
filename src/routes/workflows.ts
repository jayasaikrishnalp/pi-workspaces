import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  jsonError,
  jsonOk,
  matchPath,
  parsePath,
  readJsonBody,
} from '../server/http-helpers.js'
import type { Wiring } from '../server/wiring.js'
import {
  writeWorkflow,
  patchWorkflow,
  readWorkflow,
  listWorkflows,
  decodeSteps,
  type WorkflowStep,
  type KnownEntities,
} from '../server/workflow-writer.js'
import { listKbEntities } from '../server/kb-writer.js'
import { SkillWriteError, SKILL_NAME_RE } from '../server/skills-writer.js'

export const WORKFLOWS_PATH = '/api/workflows'
export const WORKFLOWS_DETAIL_PATTERN = '/api/workflows/:name'

async function knownEntities(w: Wiring): Promise<KnownEntities> {
  const [skills, workflows] = await Promise.all([
    listKbEntities(w.kbRoot, 'skills'),
    listKbEntities(w.kbRoot, 'workflows'),
  ])
  return { skills: new Set(skills), workflows: new Set(workflows) }
}

export async function handleWorkflowsList(_req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  try {
    const names = await listWorkflows(w.kbRoot)
    const workflows: Array<{ name: string; description?: string; steps: WorkflowStep[] }> = []
    for (const n of names) {
      try {
        const wf = await readWorkflow(w.kbRoot, n)
        const fm = wf.frontmatter
        const steps = decodeSteps(fm.steps)
        const entry: { name: string; description?: string; steps: WorkflowStep[] } = { name: n, steps }
        if (typeof fm.description === 'string') entry.description = fm.description
        workflows.push(entry)
      } catch {
        // skip unreadable
      }
    }
    jsonOk(res, 200, { workflows })
  } catch (err) {
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}

export async function handleWorkflowsCreate(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
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
  const { name, description, steps } = body as Record<string, unknown>
  if (typeof name !== 'string') {
    jsonError(res, 400, 'INVALID_WORKFLOW_NAME', 'name must be a string')
    return
  }
  if (description !== undefined && typeof description !== 'string') {
    jsonError(res, 400, 'BAD_REQUEST', 'description must be a string when provided')
    return
  }
  try {
    const known = await knownEntities(w)
    const result = await writeWorkflow(
      w.kbRoot,
      {
        name,
        description: description as string | undefined,
        steps: steps as WorkflowStep[],
      },
      known,
    )
    jsonOk(res, 201, { name, path: result.relPath })
  } catch (err) {
    handleWriteError(res, err)
  }
}

export async function handleWorkflowsRead(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(WORKFLOWS_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.name) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown workflows detail path')
    return
  }
  const name: string = params.name
  if (!SKILL_NAME_RE.test(name)) {
    jsonError(res, 400, 'INVALID_WORKFLOW_NAME', `name must match ${SKILL_NAME_RE}`)
    return
  }
  try {
    const wf = await readWorkflow(w.kbRoot, name)
    jsonOk(res, 200, { name, frontmatter: wf.frontmatter, body: wf.body, path: wf.relPath })
  } catch (err) {
    handleWriteError(res, err)
  }
}

export async function handleWorkflowsUpdate(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  const params = matchPath(WORKFLOWS_DETAIL_PATTERN, parsePath(req.url))
  if (!params || !params.name) {
    jsonError(res, 404, 'NOT_FOUND', 'unknown workflows detail path')
    return
  }
  const name: string = params.name
  if (!SKILL_NAME_RE.test(name)) {
    jsonError(res, 400, 'INVALID_WORKFLOW_NAME', `name must match ${SKILL_NAME_RE}`)
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
  const { description, steps } = body as Record<string, unknown>
  try {
    const known = await knownEntities(w)
    const result = await patchWorkflow(
      w.kbRoot,
      name,
      {
        description: description as string | undefined,
        steps: steps as WorkflowStep[] | undefined,
      },
      known,
    )
    jsonOk(res, 200, { name, path: result.relPath })
  } catch (err) {
    handleWriteError(res, err)
  }
}

function handleWriteError(res: ServerResponse, err: unknown): void {
  if (err instanceof SkillWriteError) {
    const status =
      err.code === 'INVALID_WORKFLOW_NAME' ? 400
      : err.code === 'INVALID_WORKFLOW_STEPS' ? 400
      : err.code === 'INVALID_FRONTMATTER' ? 400
      : err.code === 'BODY_TOO_LARGE' ? 400
      : err.code === 'WORKFLOW_EXISTS' ? 409
      : err.code === 'UNKNOWN_WORKFLOW' ? 404
      : 500
    const details = (err as Error & { details?: Record<string, unknown> }).details
    jsonError(res, status, err.code, err.message, details)
    return
  }
  jsonError(res, 500, 'INTERNAL', (err as Error).message)
}
