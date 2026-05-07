import { snowRequest, flatten, readEnv, SnowError } from '../snow-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  hostname: string
  limit?: number
}

/**
 * CMDB lookup for a server by hostname. Tries cmdb_ci_server first
 * (covers Windows/Linux/Solaris), then falls back to cmdb_ci_computer
 * for unclassified entries.
 */
export const findServer: ToolDef = {
  name: 'find_server',
  description: 'Look up a server CI in CMDB by hostname (covers cmdb_ci_server and cmdb_ci_computer). Returns sys_id, owner, support_group, environment, OS, IP.',
  inputSchema: {
    type: 'object',
    required: ['hostname'],
    properties: {
      hostname: { type: 'string', description: 'Hostname or FQDN. Wildcards via STARTSWITH/LIKE happen automatically.' },
      limit: { type: 'number', description: 'Max rows. Default 5.' },
    },
    additionalProperties: false,
  },
  async run(rawArgs, processEnv) {
    const args = rawArgs as Args
    const host = args.hostname?.trim()
    if (!host) throw new SnowError('BAD_ARGS', 'find_server requires hostname.')
    const env = processEnv ? readEnv(processEnv) : undefined
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 50)
    const fields = 'sys_id,name,short_description,os,ip_address,support_group,assigned_to,owned_by,company,location,environment,operational_status,sys_class_name'

    for (const table of ['cmdb_ci_server', 'cmdb_ci_computer']) {
      // Two-pass per table: exact then LIKE.
      for (const op of ['name=', 'nameLIKE']) {
        const res = await snowRequest<{ result: Record<string, unknown>[] }>(`/table/${table}`, {
          env,
          query: { sysparm_query: `${op}${host}`, sysparm_fields: fields, sysparm_limit: limit },
        })
        const rows = res.result ?? []
        if (rows.length > 0) return { table, strategy: `${op}${host}`, count: rows.length, results: rows.map(flatten) }
      }
    }
    return { table: null, strategy: null, count: 0, results: [] }
  },
}
