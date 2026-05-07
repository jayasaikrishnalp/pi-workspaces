import { snowRequest, flatten, readEnv, SnowError } from '../snow-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  short_description: string
  description?: string
  caller_id?: string
  assignment_group?: string
  assigned_to?: string
  category?: string
  subcategory?: string
  priority?: string | number
  urgency?: string | number
  impact?: string | number
  cmdb_ci?: string
  /** Free-form additional fields. Anything in here is merged into the POST body. */
  fields?: Record<string, unknown>
}

export const createIncident: ToolDef = {
  name: 'create_incident',
  description: 'Create a new incident. Returns {number, sys_id, link}.',
  inputSchema: {
    type: 'object',
    required: ['short_description'],
    properties: {
      short_description: { type: 'string' },
      description: { type: 'string' },
      caller_id: { type: 'string', description: 'sys_id or user_name of the caller. Defaults to the authenticated user if omitted.' },
      assignment_group: { type: 'string', description: 'sys_id or name of the assignment group.' },
      assigned_to: { type: 'string', description: 'sys_id or user_name of the assignee.' },
      category: { type: 'string' },
      subcategory: { type: 'string' },
      priority: { type: ['string', 'number'] },
      urgency: { type: ['string', 'number'] },
      impact: { type: ['string', 'number'] },
      cmdb_ci: { type: 'string' },
      fields: { type: 'object', description: 'Any additional fields to set, merged into the POST body verbatim.' },
    },
    additionalProperties: false,
  },
  async run(rawArgs, processEnv) {
    const args = rawArgs as Args
    if (!args.short_description) throw new SnowError('BAD_ARGS', 'create_incident requires "short_description".')
    const env = processEnv ? readEnv(processEnv) : undefined
    const body: Record<string, unknown> = { ...(args.fields ?? {}) }
    for (const k of ['short_description', 'description', 'caller_id', 'assignment_group', 'assigned_to', 'category', 'subcategory', 'priority', 'urgency', 'impact', 'cmdb_ci'] as const) {
      if (args[k] != null) body[k] = args[k]
    }
    const res = await snowRequest<{ result: Record<string, unknown> }>('/table/incident', {
      env,
      method: 'POST',
      body,
    })
    const r = flatten(res.result ?? {})
    return { number: r.number, sys_id: r.sys_id, record: r }
  },
}
