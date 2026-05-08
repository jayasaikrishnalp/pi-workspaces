import { hiveRequest, HiveError } from '../http-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  name: string
  old_string: string
  new_string: string
  file_path?: string
  replace_all?: boolean
}

export const skillPatch: ToolDef = {
  name: 'skill_patch',
  description:
    'Surgical find-and-replace inside a skill\'s SKILL.md (or a sidecar file under the skill directory). The server runs a 9-strategy fuzzy chain — exact, line_trimmed, whitespace_normalized, indentation_flexible, escape_normalized, trimmed_boundary, unicode_normalized, block_anchor, context_aware — so the agent does NOT need byte-perfect old_string. Multiple matches → 409 PATCH_AMBIGUOUS unless replace_all=true. No match → 404 PATCH_NO_MATCH (re-read the file with skill_read and try again with more surrounding context).',
  inputSchema: {
    type: 'object',
    required: ['name', 'old_string', 'new_string'],
    properties: {
      name: { type: 'string', description: 'Skill kebab-name (the directory name under skills/).' },
      old_string: { type: 'string', description: 'Text to replace. Provide enough surrounding context to be unique.' },
      new_string: { type: 'string', description: 'Replacement text. Use "" to delete.' },
      file_path: { type: 'string', description: 'Path RELATIVE to the skill directory. Defaults to "SKILL.md". E.g. "references/foo.md".' },
      replace_all: { type: 'boolean', description: 'Replace every match instead of failing on multiple. Default false.' },
    },
    additionalProperties: false,
  },
  async run(rawArgs) {
    const { name, old_string, new_string, file_path, replace_all } = rawArgs as Args
    if (!name) throw new HiveError('BAD_ARGS', 'name is required')
    if (typeof old_string !== 'string' || old_string.length === 0) throw new HiveError('BAD_ARGS', 'old_string must be a non-empty string')
    if (typeof new_string !== 'string') throw new HiveError('BAD_ARGS', 'new_string must be a string')
    return hiveRequest(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: { old_string, new_string, file_path, replace_all },
    })
  },
}
