import { snowRequest, flatten, readEnv } from '../snow-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  query: string
  fields?: string[]
  limit?: number
}

export const searchIncidents: ToolDef = {
  name: 'search_incidents',
  description: 'Search incidents using a SNOW encoded query (sysparm_query). Examples: "active=true^assigned_to.user_name=ado_integration_user", "stateIN1,2,3", "short_descriptionLIKEdisk full".',
  inputSchema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'SNOW encoded query (sysparm_query). Use ^ to AND, ^OR to OR, LIKE / =/ != / IN.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Fields to return. Default: number, short_description, state, priority, assigned_to, sys_id.' },
      limit: { type: 'number', description: 'Max rows. Default 50, max 500.' },
    },
    additionalProperties: false,
  },
  async run(rawArgs, processEnv) {
    const args = rawArgs as Args
    const env = processEnv ? readEnv(processEnv) : undefined
    const fields = (args.fields ?? ['number', 'short_description', 'state', 'priority', 'assigned_to', 'sys_id']).join(',')
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 500)
    const res = await snowRequest<{ result: Record<string, unknown>[] }>('/table/incident', {
      env,
      query: { sysparm_query: args.query, sysparm_fields: fields, sysparm_limit: limit },
    })
    return { count: res.result?.length ?? 0, results: (res.result ?? []).map(flatten) }
  },
}
