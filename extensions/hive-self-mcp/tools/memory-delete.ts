import { hiveRequest, HiveError } from '../http-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args { name: string }

export const memoryDelete: ToolDef = {
  name: 'memory_delete',
  description:
    'Delete a memory entry. 404 when the entry does not exist (idempotency must be handled by the caller — Hive returns UNKNOWN_MEMORY rather than silently succeeding).',
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Kebab-case memory name to delete.' },
    },
    additionalProperties: false,
  },
  async run(rawArgs) {
    const { name } = rawArgs as Args
    if (!name) throw new HiveError('BAD_ARGS', 'name is required')
    return hiveRequest(`/api/memory/${encodeURIComponent(name)}`, { method: 'DELETE' })
  },
}
