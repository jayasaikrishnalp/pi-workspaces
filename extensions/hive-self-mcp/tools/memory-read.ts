import { hiveRequest, HiveError } from '../http-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args { name: string }

export const memoryRead: ToolDef = {
  name: 'memory_read',
  description:
    'Read a memory entry by name. Returns body + size + mtime. 404 when the memory does not exist.',
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Kebab-case memory name, e.g. "user", "project"' },
    },
    additionalProperties: false,
  },
  async run(rawArgs) {
    const { name } = rawArgs as Args
    if (!name || typeof name !== 'string') throw new HiveError('BAD_ARGS', 'name is required')
    return hiveRequest(`/api/memory/${encodeURIComponent(name)}`)
  },
}
