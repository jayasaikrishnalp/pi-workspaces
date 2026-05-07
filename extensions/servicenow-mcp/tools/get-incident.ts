import { snowRequest, flatten, readEnv, SnowError } from '../snow-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  number?: string
  sys_id?: string
  fields?: string[]
}

export const getIncident: ToolDef = {
  name: 'get_incident',
  description: 'Fetch a single incident by number (e.g. INC0012345) or sys_id. Returns the full record with display values.',
  inputSchema: {
    type: 'object',
    properties: {
      number: { type: 'string', description: 'Incident number, e.g. "INC0012345". Either this or sys_id is required.' },
      sys_id: { type: 'string', description: 'Sys ID of the incident. Either this or number is required.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Optional list of fields to return (sysparm_fields). Default: all.' },
    },
    additionalProperties: false,
  },
  async run(rawArgs, processEnv) {
    const args = rawArgs as Args
    if (!args.number && !args.sys_id) {
      throw new SnowError('BAD_ARGS', 'get_incident requires "number" or "sys_id".')
    }
    const env = processEnv ? readEnv(processEnv) : undefined
    const fields = args.fields?.join(',')
    if (args.sys_id) {
      const res = await snowRequest<{ result: Record<string, unknown> }>(`/table/incident/${args.sys_id}`, {
        env,
        query: fields ? { sysparm_fields: fields } : undefined,
      })
      return flatten(res.result ?? {})
    }
    const res = await snowRequest<{ result: Record<string, unknown>[] }>('/table/incident', {
      env,
      query: { sysparm_query: `number=${args.number}`, sysparm_limit: 1, sysparm_fields: fields },
    })
    const row = res.result?.[0]
    if (!row) throw new SnowError('NOT_FOUND', `incident ${args.number} not found`)
    return flatten(row)
  },
}
