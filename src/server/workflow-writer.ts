import {
  writeKbFile,
  updateKbFile,
  readKbFile,
  listKbEntities,
  type WriteKbFileResult,
} from './kb-writer.js'
import { SkillWriteError } from './skills-writer.js'

export interface WorkflowStep {
  kind: 'skill' | 'workflow'
  ref: string
}

export interface WorkflowInput {
  name: string
  description?: string
  steps: WorkflowStep[]
}

export interface KnownEntities {
  skills: Set<string>
  workflows: Set<string>
}

/**
 * Encode steps as "<kind>:<ref>" string array (the shallow-YAML parser only
 * supports string scalars and string arrays; nested objects would require a
 * full YAML library).
 */
export function encodeSteps(steps: WorkflowStep[]): string[] {
  return steps.map((s) => `${s.kind}:${s.ref}`)
}

export function decodeSteps(raw: unknown): WorkflowStep[] {
  if (!Array.isArray(raw)) return []
  const out: WorkflowStep[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const colon = item.indexOf(':')
    if (colon < 0) continue
    const kind = item.slice(0, colon)
    const ref = item.slice(colon + 1)
    if (kind === 'skill' || kind === 'workflow') out.push({ kind, ref })
  }
  return out
}

export async function writeWorkflow(
  kbRoot: string,
  input: WorkflowInput,
  known: KnownEntities,
): Promise<WriteKbFileResult> {
  validateSteps(input.steps, known)
  const frontmatter: Record<string, unknown> = {
    name: input.name,
    steps: encodeSteps(input.steps),
  }
  if (input.description !== undefined) frontmatter.description = input.description
  return writeKbFile(kbRoot, { kind: 'workflows', name: input.name, frontmatter, body: '' })
}

export async function patchWorkflow(
  kbRoot: string,
  name: string,
  patch: { description?: string; steps?: WorkflowStep[] },
  known: KnownEntities,
): Promise<WriteKbFileResult> {
  const existing = await readKbFile(kbRoot, 'workflows', name)
  if (patch.steps !== undefined) validateSteps(patch.steps, known)

  const merged: Record<string, unknown> = { ...existing.frontmatter }
  if (patch.description !== undefined) merged.description = patch.description
  if (patch.steps !== undefined) merged.steps = encodeSteps(patch.steps)

  return updateKbFile(kbRoot, {
    kind: 'workflows',
    name,
    frontmatter: merged,
    existingFrontmatter: existing.frontmatter,
    existingBody: existing.body,
  })
}

export async function readWorkflow(kbRoot: string, name: string) {
  return readKbFile(kbRoot, 'workflows', name)
}

export async function listWorkflows(kbRoot: string): Promise<string[]> {
  return listKbEntities(kbRoot, 'workflows')
}

function validateSteps(steps: unknown, known: KnownEntities): asserts steps is WorkflowStep[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new SkillWriteError('INVALID_WORKFLOW_STEPS', 'steps must be a non-empty array')
  }
  const missing: WorkflowStep[] = []
  for (const s of steps) {
    if (!s || typeof s !== 'object' || (s as { kind?: unknown }).kind === undefined) {
      throw new SkillWriteError('INVALID_WORKFLOW_STEPS', 'each step must be {kind, ref}')
    }
    const step = s as { kind: unknown; ref: unknown }
    if ((step.kind !== 'skill' && step.kind !== 'workflow') || typeof step.ref !== 'string' || step.ref.length === 0) {
      throw new SkillWriteError('INVALID_WORKFLOW_STEPS', 'each step must have kind:"skill"|"workflow" and a non-empty ref')
    }
    const set = step.kind === 'skill' ? known.skills : known.workflows
    if (!set.has(step.ref)) missing.push({ kind: step.kind, ref: step.ref })
  }
  if (missing.length > 0) {
    const err = new SkillWriteError(
      'INVALID_WORKFLOW_STEPS',
      `workflow references unknown entities: ${missing.map((m) => `${m.kind}:${m.ref}`).join(', ')}`,
    )
    ;(err as Error & { details?: { missing: WorkflowStep[] } }).details = { missing }
    throw err
  }
}
