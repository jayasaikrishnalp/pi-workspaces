import {
  writeKbFile,
  updateKbFile,
  readKbFile,
  listKbEntities,
  type WriteKbFileResult,
} from './kb-writer.js'
import { SkillWriteError } from './skills-writer.js'

export interface AgentInput {
  name: string
  description?: string
  skills: string[]
  persona?: string
}

/**
 * Write a new agent. The `skills` array MUST reference existing skill names —
 * the caller passes in `knownSkills` (a Set built once from listKbEntities so
 * we don't re-walk the disk per write).
 */
export async function writeAgent(
  kbRoot: string,
  input: AgentInput,
  knownSkills: Set<string>,
): Promise<WriteKbFileResult> {
  validateSkills(input.skills, knownSkills)
  const frontmatter: Record<string, unknown> = {
    name: input.name,
    skills: input.skills,
  }
  if (input.description !== undefined) frontmatter.description = input.description
  if (input.persona !== undefined) frontmatter.persona = input.persona
  return writeKbFile(kbRoot, { kind: 'agents', name: input.name, frontmatter, body: '' })
}

/** Update an existing agent. Re-validates skills if `skills` is provided. */
export async function patchAgent(
  kbRoot: string,
  name: string,
  patch: { description?: string; skills?: string[]; persona?: string },
  knownSkills: Set<string>,
): Promise<WriteKbFileResult> {
  const existing = await readKbFile(kbRoot, 'agents', name)
  if (patch.skills !== undefined) validateSkills(patch.skills, knownSkills)

  const merged: Record<string, unknown> = { ...existing.frontmatter }
  if (patch.description !== undefined) merged.description = patch.description
  if (patch.skills !== undefined) merged.skills = patch.skills
  if (patch.persona !== undefined) merged.persona = patch.persona

  return updateKbFile(kbRoot, {
    kind: 'agents',
    name,
    frontmatter: merged,
    existingFrontmatter: existing.frontmatter,
    existingBody: existing.body,
  })
}

export async function readAgent(kbRoot: string, name: string) {
  return readKbFile(kbRoot, 'agents', name)
}

export async function listAgents(kbRoot: string): Promise<string[]> {
  return listKbEntities(kbRoot, 'agents')
}

function validateSkills(skills: unknown, knownSkills: Set<string>): asserts skills is string[] {
  if (!Array.isArray(skills) || skills.length === 0) {
    throw new SkillWriteError('INVALID_AGENT_SKILLS', 'skills must be a non-empty string array')
  }
  if (!skills.every((s) => typeof s === 'string' && s.length > 0)) {
    throw new SkillWriteError('INVALID_AGENT_SKILLS', 'skills must contain only non-empty strings')
  }
  const missing = skills.filter((s) => !knownSkills.has(s))
  if (missing.length > 0) {
    const err = new SkillWriteError(
      'INVALID_AGENT_SKILLS',
      `agent references unknown skills: ${missing.join(', ')}`,
    )
    ;(err as Error & { details?: { missing: string[] } }).details = { missing }
    throw err
  }
}
