import { snowRequest, flatten, readEnv, SnowError } from '../snow-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  sys_id?: string
  number?: string
  fields: Record<string, unknown>
}

async function resolveSysId(args: Args, env?: ReturnType<typeof readEnv>): Promise<string> {
  if (args.sys_id) return args.sys_id
  if (!args.number) throw new SnowError('BAD_ARGS', 'update_incident requires "sys_id" or "number".')
  const res = await snowRequest<{ result: { sys_id: string }[] }>('/table/incident', {
    env,
    query: { sysparm_query: `number=${args.number}`, sysparm_fields: 'sys_id', sysparm_limit: 1 },
    display: false,
  })
  const sysId = res.result?.[0]?.sys_id
  if (!sysId) throw new SnowError('NOT_FOUND', `incident ${args.number} not found`)
  return sysId
}

export const updateIncident: ToolDef = {
  name: 'update_incident',
  description: 'PATCH arbitrary fields on an incident. Pass either sys_id or number plus a fields bag. Use resolve_incident for the special quartet (state=6, close_code, close_notes, assigned_to).',
  inputSchema: {
    type: 'object',
    required: ['fields'],
    properties: {
      sys_id: { type: 'string' },
      number: { type: 'string' },
      fields: { type: 'object', description: 'Fields to PATCH. Free-form bag.', additionalProperties: true },
    },
    additionalProperties: false,
  },
  async run(rawArgs, processEnv) {
    const args = rawArgs as Args
    if (!args.fields || typeof args.fields !== 'object' || Array.isArray(args.fields)) {
      throw new SnowError('BAD_ARGS', 'update_incident requires a "fields" object.')
    }
    const env = processEnv ? readEnv(processEnv) : undefined
    const sysId = await resolveSysId(args, env)
    const res = await snowRequest<{ result: Record<string, unknown> }>(`/table/incident/${sysId}`, {
      env,
      method: 'PATCH',
      body: args.fields,
    })
    return flatten(res.result ?? {})
  },
}
