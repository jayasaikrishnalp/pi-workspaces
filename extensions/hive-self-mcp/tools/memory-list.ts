import { hiveRequest } from '../http-client.ts'
import type { ToolDef } from './_registry.ts'

export const memoryList: ToolDef = {
  name: 'memory_list',
  description:
    'List every memory entry in the Hive workspace, ordered most-recently-modified first. Returns name + size + mtime per entry.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async run() {
    const res = await hiveRequest<{ entries: Array<{ name: string; size: number; mtime: number }> }>('/api/memory')
    return res
  },
}
