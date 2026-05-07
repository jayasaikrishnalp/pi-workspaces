import { snowRequest, flatten, readEnv, SnowError } from '../snow-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  hostname?: string
  ci_sys_id?: string
  limit?: number
}

/**
 * Walk task_ci → task to find every active task touching a CI. Two-step:
 * (1) hostname → cmdb_ci.sys_id, (2) task_ci.ci_item=<sysId> → task_ids,
 * (3) task table for the parents.
 */
export const listTasksForCi: ToolDef = {
  name: 'list_tasks_for_ci',
  description: 'List all tasks (incident/change_task/sc_task/problem_task) attached to a CI via task_ci. Provide hostname or ci_sys_id.',
  inputSchema: {
    type: 'object',
    properties: {
      hostname: { type: 'string', description: 'Either this or ci_sys_id required.' },
      ci_sys_id: { type: 'string' },
      limit: { type: 'number', description: 'Max tasks. Default 100.' },
    },
    additionalProperties: false,
  },
  async run(rawArgs, processEnv) {
    const args = rawArgs as Args
    if (!args.hostname && !args.ci_sys_id) {
      throw new SnowError('BAD_ARGS', 'list_tasks_for_ci requires hostname or ci_sys_id.')
    }
    const env = processEnv ? readEnv(processEnv) : undefined
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 500)

    let ciId = args.ci_sys_id
    if (!ciId) {
      const ci = await snowRequest<{ result: { sys_id: string }[] }>('/table/cmdb_ci', {
        env,
        query: { sysparm_query: `name=${args.hostname}`, sysparm_fields: 'sys_id', sysparm_limit: 1 },
        display: false,
      })
      ciId = ci.result?.[0]?.sys_id
      if (!ciId) return { ci_sys_id: null, count: 0, results: [], note: `no CI for hostname "${args.hostname}"` }
    }

    const link = await snowRequest<{ result: { task: { value?: string } | string }[] }>('/table/task_ci', {
      env,
      query: { sysparm_query: `ci_item=${ciId}`, sysparm_fields: 'task', sysparm_limit: limit },
      display: false,
    })
    const taskIds = (link.result ?? []).map((r) => {
      const t = r.task
      if (typeof t === 'string') return t
      return t?.value
    }).filter((x): x is string => !!x)
    if (taskIds.length === 0) return { ci_sys_id: ciId, count: 0, results: [] }

    const fields = 'number,sys_id,sys_class_name,short_description,state,priority,assigned_to,assignment_group,opened_at'
    const res = await snowRequest<{ result: Record<string, unknown>[] }>('/table/task', {
      env,
      query: { sysparm_query: `sys_idIN${taskIds.join(',')}`, sysparm_fields: fields, sysparm_limit: limit },
    })
    return { ci_sys_id: ciId, count: res.result?.length ?? 0, results: (res.result ?? []).map(flatten) }
  },
}
