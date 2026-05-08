import { hiveRequest, HiveError } from '../http-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  name: string
  content?: string
  description?: string
  frontmatter?: Record<string, unknown>
}

export const skillEdit: ToolDef = {
  name: 'skill_edit',
  description:
    'Full-body rewrite of an existing skill. Merge semantics: omitted body keeps the prior body; provided frontmatter REPLACES the prior frontmatter (except `name`, locked). Prefer skill_patch for surgical edits — this tool overwrites everything you don\'t carry forward.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      content: { type: 'string', description: 'Full new body. Omit to keep the existing body unchanged.' },
      description: { type: 'string', description: 'Shortcut to update only frontmatter.description.' },
      frontmatter: { type: 'object', additionalProperties: true },
    },
    additionalProperties: false,
  },
  async run(rawArgs) {
    const { name, content, description, frontmatter } = rawArgs as Args
    if (!name) throw new HiveError('BAD_ARGS', 'name is required')
    const fm: Record<string, unknown> | undefined = frontmatter ?? (description != null ? { description } : undefined)
    return hiveRequest(`/api/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: { content, frontmatter: fm },
    })
  },
}
