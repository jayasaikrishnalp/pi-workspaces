import { hiveRequest } from '../http-client.ts'
import type { ToolDef } from './_registry.ts'

interface KbNode { id: string; source: string; description?: string; [k: string]: unknown }
interface KbGraph { nodes: KbNode[] }

export const skillList: ToolDef = {
  name: 'skill_list',
  description:
    'List every SKILL.md the workspace knows about. Returns name + description for each skill, filtered out of the wider kb-graph.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async run() {
    const graph = await hiveRequest<KbGraph>('/api/kb/graph')
    const skills = (graph.nodes ?? [])
      .filter((n) => n.source === 'skill')
      .map((n) => ({ name: n.id, description: n.description ?? '' }))
    return { count: skills.length, skills }
  },
}
