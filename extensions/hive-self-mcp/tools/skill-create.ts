import { hiveRequest, HiveError } from '../http-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  name: string
  content: string
  description?: string
  frontmatter?: Record<string, unknown>
}

export const skillCreate: ToolDef = {
  name: 'skill_create',
  description:
    'Create a brand-new skill at <skills>/<name>/SKILL.md. The server enforces kebab-case names (^[a-z][a-z0-9-]{0,63}$), 32 KB body limit, and YAML frontmatter validation. 409 SKILL_EXISTS if the name is taken — use skill_edit / skill_patch instead.',
  inputSchema: {
    type: 'object',
    required: ['name', 'content'],
    properties: {
      name: { type: 'string', description: 'Kebab-case directory name. e.g. "query-jira".' },
      content: { type: 'string', description: 'Raw markdown body of SKILL.md (without frontmatter — supply that via the `description` field or the `frontmatter` object).' },
      description: { type: 'string', description: 'Convenience: rendered as `description:` in frontmatter. Used by pi to decide when to load the skill — write it punchily.' },
      frontmatter: {
        type: 'object',
        description: 'Optional full frontmatter object (overrides description if both provided). Only string and string[] values are accepted server-side.',
        additionalProperties: true,
      },
    },
    additionalProperties: false,
  },
  async run(rawArgs) {
    const { name, content, description, frontmatter } = rawArgs as Args
    if (!name) throw new HiveError('BAD_ARGS', 'name is required')
    if (typeof content !== 'string') throw new HiveError('BAD_ARGS', 'content must be a string')
    const fm: Record<string, unknown> = { ...(frontmatter ?? {}) }
    if (description && fm.description == null) fm.description = description
    return hiveRequest('/api/skills', {
      method: 'POST',
      body: { name, content, frontmatter: fm },
    })
  },
}
