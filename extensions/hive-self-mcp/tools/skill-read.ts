import { hiveRequest, HiveError } from '../http-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args { name: string }

export const skillRead: ToolDef = {
  name: 'skill_read',
  description:
    'Read a skill\'s SKILL.md by name. Returns parsed frontmatter + raw body. Use this BEFORE skill_edit / skill_patch so you don\'t clobber existing content.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Kebab-case skill name (the directory name under skills/).' },
    },
    additionalProperties: false,
  },
  async run(rawArgs) {
    const { name } = rawArgs as Args
    if (!name) throw new HiveError('BAD_ARGS', 'name is required')
    return hiveRequest(`/api/kb/skill/${encodeURIComponent(name)}`)
  },
}
