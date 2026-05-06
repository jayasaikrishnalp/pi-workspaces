import {
  writeKbFile,
  updateKbFile,
  readKbFile,
  listKbEntities,
} from './kb-writer.js'
import { SkillWriteError } from './skills-writer.js'

/**
 * Soul = the agent's character/identity definition. Reusable across multiple
 * agents via their optional `soul:` frontmatter field. Mirrors the
 * agent-writer / workflow-writer pattern over kb-writer.
 */
export interface SoulInput {
  name: string
  description?: string
  values?: string[]
  priorities?: string[]
  risk_tolerance?: string
  decision_principles?: string[]
  tone?: string
  model_preference?: string
  body?: string
}

export type SoulPatch = Omit<SoulInput, 'name' | 'body'> & { body?: string }

function buildFrontmatter(input: Partial<SoulInput> & { name?: string }): Record<string, string | string[]> {
  const fm: Record<string, string | string[]> = {}
  if (input.name) fm.name = input.name
  if (input.description) fm.description = input.description
  if (input.values?.length) fm.values = input.values
  if (input.priorities?.length) fm.priorities = input.priorities
  if (input.risk_tolerance) fm.risk_tolerance = input.risk_tolerance
  if (input.decision_principles?.length) fm.decision_principles = input.decision_principles
  if (input.tone) fm.tone = input.tone
  if (input.model_preference) fm.model_preference = input.model_preference
  return fm
}

export async function writeSoul(kbRoot: string, input: SoulInput) {
  return writeKbFile(kbRoot, {
    kind: 'souls',
    name: input.name,
    body: input.body ?? '',
    frontmatter: buildFrontmatter(input),
  })
}

export async function patchSoul(kbRoot: string, name: string, patch: SoulPatch) {
  const existing = await readKbFile(kbRoot, 'souls', name).catch(() => null)
  if (!existing) {
    throw new SkillWriteError('UNKNOWN_SOUL', `soul ${name} does not exist`)
  }
  const merged: Record<string, string | string[]> = {
    ...(existing.frontmatter as Record<string, string | string[]>),
    ...buildFrontmatter(patch),
    name,
  }
  return updateKbFile(kbRoot, {
    kind: 'souls',
    name,
    body: patch.body ?? existing.body,
    frontmatter: merged,
    existingFrontmatter: existing.frontmatter,
    existingBody: existing.body,
  })
}

export async function readSoul(kbRoot: string, name: string) {
  return readKbFile(kbRoot, 'souls', name)
}

export async function listSouls(kbRoot: string): Promise<string[]> {
  return listKbEntities(kbRoot, 'souls')
}
