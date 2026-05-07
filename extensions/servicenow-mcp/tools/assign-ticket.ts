import { snowRequest, flatten, readEnv, SnowError } from '../snow-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  table: string
  sys_id?: string
  number?: string
  assigned_to?: string
  assignment_group?: string
}

const ALLOWED_TABLES = new Set([
  'incident', 'change_request', 'change_task', 'sc_req_item', 'sc_task', 'problem', 'task',
])

export const assignTicket: ToolDef = {
  name: 'assign_ticket',
  description: 'Set assigned_to and/or assignment_group on any task-style record (incident, change_request, change_task, sc_req_item, sc_task, problem, task).',
  inputSchema: {
    type: 'object',
    required: ['table'],
    properties: {
      table: { type: 'string', enum: Array.from(ALLOWED_TABLES), description: 'Target SNOW table.' },
      sys_id: { type: 'string' },
      number: { type: 'string' },
      assigned_to: { type: 'string' },
      assignment_group: { type: 'string' },
    },
    additionalProperties: false,
  },
  async run(rawArgs, processEnv) {
    const args = rawArgs as Args
    if (!ALLOWED_TABLES.has(args.table)) {
      throw new SnowError('BAD_ARGS', `assign_ticket: table "${args.table}" is not in the allowed list.`)
    }
    if (!args.assigned_to && !args.assignment_group) {
      throw new SnowError('BAD_ARGS', 'assign_ticket: provide at least one of assigned_to or assignment_group.')
    }
    if (!args.sys_id && !args.number) {
      throw new SnowError('BAD_ARGS', 'assign_ticket: provide sys_id or number.')
    }
    const env = processEnv ? readEnv(processEnv) : undefined
    let sysId = args.sys_id
    if (!sysId) {
      const lookup = await snowRequest<{ result: { sys_id: string }[] }>(`/table/${args.table}`, {
        env,
        query: { sysparm_query: `number=${args.number}`, sysparm_fields: 'sys_id', sysparm_limit: 1 },
        display: false,
      })
      sysId = lookup.result?.[0]?.sys_id
      if (!sysId) throw new SnowError('NOT_FOUND', `${args.table} ${args.number} not found`)
    }
    const body: Record<string, unknown> = {}
    if (args.assigned_to) body.assigned_to = args.assigned_to
    if (args.assignment_group) body.assignment_group = args.assignment_group
    const res = await snowRequest<{ result: Record<string, unknown> }>(`/table/${args.table}/${sysId}`, {
      env,
      method: 'PATCH',
      body,
    })
    return flatten(res.result ?? {})
  },
}
