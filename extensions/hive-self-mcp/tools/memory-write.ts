import { hiveRequest, HiveError } from '../http-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args { name: string; content: string }

export const memoryWrite: ToolDef = {
  name: 'memory_write',
  description:
    'Upsert a memory entry. Server runs a threat scan (refuses prompt-injection / credential exfiltration / role-hijack patterns) and refuses content > 65 KB. Returns post-write metadata. By convention, use name="user" for user-preference facts and name="project" for workspace-level facts.',
  inputSchema: {
    type: 'object',
    required: ['name', 'content'],
    properties: {
      name: { type: 'string', description: 'Kebab-case memory name. Reserved: "user", "project".' },
      content: { type: 'string', description: 'Full new content. PUT semantics — replaces any prior body.' },
    },
    additionalProperties: false,
  },
  async run(rawArgs) {
    const { name, content } = rawArgs as Args
    if (!name) throw new HiveError('BAD_ARGS', 'name is required')
    if (typeof content !== 'string') throw new HiveError('BAD_ARGS', 'content must be a string')
    return hiveRequest(`/api/memory/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: { content },
    })
  },
}
