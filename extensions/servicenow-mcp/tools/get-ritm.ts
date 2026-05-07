import { snowRequest, flatten, readEnv, SnowError } from '../snow-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  number?: string
  sys_id?: string
  /** When true, also fetch sc_item_option_mtom variables for the RITM. */
  include_variables?: boolean
}

/**
 * Fetch a Request Item (RITM) by number or sys_id. Pulls the meaty fields
 * (requested_for, opened_by, stage, state, sysapproval, parent request)
 * and optionally the catalog item variables.
 */
export const getRitm: ToolDef = {
  name: 'get_ritm',
  description: 'Fetch a Request Item (RITM) by number (e.g. RITM1873427) or sys_id. Returns short_description, requested_for, opened_by, stage, state, parent request, sysapproval, and (optionally) catalog item variables.',
  inputSchema: {
    type: 'object',
    properties: {
      number: { type: 'string', description: 'RITM number, e.g. "RITM1873427".' },
      sys_id: { type: 'string' },
      include_variables: { type: 'boolean', description: 'Pull catalog variables via sc_item_option_mtom. Default false.' },
    },
    additionalProperties: false,
  },
  async run(rawArgs, processEnv) {
    const args = rawArgs as Args
    if (!args.number && !args.sys_id) {
      throw new SnowError('BAD_ARGS', 'get_ritm requires number or sys_id.')
    }
    const env = processEnv ? readEnv(processEnv) : undefined
    const fields = [
      'number', 'sys_id', 'short_description', 'description',
      'state', 'stage', 'request', 'sysapproval', 'approval',
      'opened_by', 'opened_at', 'requested_for', 'cat_item',
      'price', 'recurring_price', 'quantity',
      'assignment_group', 'assigned_to',
      'sys_created_on', 'sys_updated_on', 'closed_at',
    ].join(',')

    let row: Record<string, unknown> | undefined
    if (args.sys_id) {
      const res = await snowRequest<{ result: Record<string, unknown> }>(`/table/sc_req_item/${args.sys_id}`, {
        env,
        query: { sysparm_fields: fields },
      })
      row = res.result
    } else {
      const res = await snowRequest<{ result: Record<string, unknown>[] }>('/table/sc_req_item', {
        env,
        query: { sysparm_query: `number=${args.number}`, sysparm_fields: fields, sysparm_limit: 1 },
      })
      row = res.result?.[0]
      if (!row) throw new SnowError('NOT_FOUND', `RITM ${args.number} not found`)
    }

    const flat = flatten(row ?? {})

    if (args.include_variables) {
      const ritmSysId = (typeof flat.sys_id === 'object' ? (flat.sys_id as { value: string }).value : flat.sys_id) as string
      const vars = await snowRequest<{ result: Record<string, unknown>[] }>('/table/sc_item_option_mtom', {
        env,
        query: { sysparm_query: `request_item=${ritmSysId}`, sysparm_fields: 'sc_item_option', sysparm_limit: 200 },
        display: false,
      })
      const optionIds = (vars.result ?? []).map((r) => {
        const v = r.sc_item_option as { value?: string } | string | undefined
        return typeof v === 'string' ? v : v?.value
      }).filter((x): x is string => !!x)
      if (optionIds.length > 0) {
        const opts = await snowRequest<{ result: Record<string, unknown>[] }>('/table/sc_item_option', {
          env,
          query: {
            sysparm_query: `sys_idIN${optionIds.join(',')}`,
            sysparm_fields: 'item_option_new,value',
            sysparm_limit: 200,
          },
        })
        ;(flat as Record<string, unknown>).variables = (opts.result ?? []).map(flatten)
      } else {
        ;(flat as Record<string, unknown>).variables = []
      }
    }
    return flat
  },
}
