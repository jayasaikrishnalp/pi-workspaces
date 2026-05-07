import { snowRequest, flatten, readEnv, SnowError } from '../snow-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  hostname: string
  /** ISO date or YYYY-MM-DD. Default: 30 days ago. */
  since?: string
  /** ISO date or YYYY-MM-DD. Default: today. */
  until?: string
  /** When true, include closed changes. Default false. */
  include_closed?: boolean
  limit?: number
}

/**
 * Find change requests touching a hostname in a date window.
 * SNOW-side: cmdb_ci.name → change_request.cmdb_ci. We pre-resolve the
 * CI sys_id to keep the change_request query cheap.
 */
export const getChangesForHost: ToolDef = {
  name: 'get_changes_for_host',
  description: 'List change requests touching a host in a date window. By default returns only open/active changes (states 3-5: Implement, Review, Closed).',
  inputSchema: {
    type: 'object',
    required: ['hostname'],
    properties: {
      hostname: { type: 'string' },
      since: { type: 'string', description: 'ISO date or YYYY-MM-DD. Default 30d ago.' },
      until: { type: 'string', description: 'ISO date or YYYY-MM-DD. Default today.' },
      include_closed: { type: 'boolean', description: 'Include state=closed/cancelled. Default false.' },
      limit: { type: 'number', description: 'Max rows. Default 50.' },
    },
    additionalProperties: false,
  },
  async run(rawArgs, processEnv) {
    const args = rawArgs as Args
    if (!args.hostname?.trim()) throw new SnowError('BAD_ARGS', 'get_changes_for_host requires hostname.')
    const env = processEnv ? readEnv(processEnv) : undefined
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 500)

    // 1. Resolve CI sys_id(s) for the hostname.
    const ci = await snowRequest<{ result: { sys_id: string }[] }>('/table/cmdb_ci', {
      env,
      query: { sysparm_query: `name=${args.hostname.trim()}`, sysparm_fields: 'sys_id', sysparm_limit: 5 },
      display: false,
    })
    const ciIds = (ci.result ?? []).map((r) => r.sys_id).filter(Boolean)
    if (ciIds.length === 0) {
      return { ci_count: 0, count: 0, results: [], note: `no CMDB CI found for hostname "${args.hostname}"` }
    }

    // 2. Window. SNOW expects local-style "YYYY-MM-DD HH:mm:ss" but ISO works too.
    const now = new Date()
    const defaultSince = new Date(now.getTime() - 30 * 24 * 3600 * 1000)
    const sinceStr = args.since ?? defaultSince.toISOString().slice(0, 10)
    const untilStr = args.until ?? now.toISOString().slice(0, 10)

    // 3. Query change_request.
    const stateClause = args.include_closed ? '' : '^stateIN-1,0,1,2,3,4,5'
    const sysparm_query = `cmdb_ciIN${ciIds.join(',')}^start_date>=${sinceStr}^start_date<=${untilStr}${stateClause}^ORDERBYDESCstart_date`
    const fields = 'number,sys_id,state,short_description,start_date,end_date,assignment_group,assigned_to,risk,impact,type'
    const res = await snowRequest<{ result: Record<string, unknown>[] }>('/table/change_request', {
      env,
      query: { sysparm_query, sysparm_fields: fields, sysparm_limit: limit },
    })
    return { ci_count: ciIds.length, count: res.result?.length ?? 0, results: (res.result ?? []).map(flatten) }
  },
}
