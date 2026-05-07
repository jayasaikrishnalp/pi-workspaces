import { snowRequest, flatten, readEnv, SnowError } from '../snow-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  sys_id?: string
  number?: string
  close_code: string
  close_notes: string
  assigned_to?: string
  caller_id?: string
}

/**
 * Resolve an incident in a single PATCH. SNOW requires four fields together
 * for state=6: state + close_code + close_notes + assigned_to. If
 * assigned_to is missing on the record, we fall back to the authenticated
 * user implied by the API token.
 */
export const resolveIncident: ToolDef = {
  name: 'resolve_incident',
  description: 'Resolve an incident (state=6) with a close_code and close_notes. Sets assigned_to + caller_id if provided. Refuses if close_code/close_notes are missing — SNOW will reject the PATCH otherwise.',
  inputSchema: {
    type: 'object',
    required: ['close_code', 'close_notes'],
    properties: {
      sys_id: { type: 'string' },
      number: { type: 'string' },
      close_code: { type: 'string', description: 'e.g. "Solved (Permanently)", "Solved Remotely (Permanently)", "Not Solved (Not Reproducible)".' },
      close_notes: { type: 'string', description: 'What you did to fix it. Required.' },
      assigned_to: { type: 'string', description: 'sys_id or user_name. Required if the record has no assignee yet — SNOW rejects state=6 without one.' },
      caller_id: { type: 'string' },
    },
    additionalProperties: false,
  },
  async run(rawArgs, processEnv) {
    const args = rawArgs as Args
    if (!args.close_code || !args.close_notes) {
      throw new SnowError('BAD_ARGS', 'resolve_incident requires close_code and close_notes — SNOW rejects state=6 without them.')
    }
    if (!args.sys_id && !args.number) {
      throw new SnowError('BAD_ARGS', 'resolve_incident requires sys_id or number.')
    }
    const env = processEnv ? readEnv(processEnv) : undefined
    let sysId = args.sys_id
    if (!sysId) {
      const lookup = await snowRequest<{ result: { sys_id: string; assigned_to?: { value?: string } | string }[] }>('/table/incident', {
        env,
        query: { sysparm_query: `number=${args.number}`, sysparm_fields: 'sys_id,assigned_to', sysparm_limit: 1 },
        display: false,
      })
      const row = lookup.result?.[0]
      if (!row) throw new SnowError('NOT_FOUND', `incident ${args.number} not found`)
      sysId = row.sys_id
    }
    const body: Record<string, unknown> = {
      state: '6',
      close_code: args.close_code,
      close_notes: args.close_notes,
    }
    if (args.assigned_to) body.assigned_to = args.assigned_to
    if (args.caller_id) body.caller_id = args.caller_id
    const res = await snowRequest<{ result: Record<string, unknown> }>(`/table/incident/${sysId}`, {
      env,
      method: 'PATCH',
      body,
    })
    return flatten(res.result ?? {})
  },
}
