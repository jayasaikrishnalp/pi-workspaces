import { snowRequest, flatten, readEnv, SnowError } from '../snow-client.ts'
import type { ToolDef } from './_registry.ts'

interface Args {
  /** Free-form query — name, email, user_name (sAMAccountName), or "First Last". */
  q: string
  limit?: number
}

/**
 * Find users in sys_user with a 7-strategy fallback so "First Middle Last"
 * matches even when the name has middle parts, suffixes, or only a partial
 * match in SNOW. Each strategy returns early as soon as it finds a hit.
 */
export const findUser: ToolDef = {
  name: 'find_user',
  description: 'Search sys_user with a 7-strategy fallback (exact name, email, user_name, first+last, partial name, etc). Returns the matched user(s). Useful before setting assigned_to / caller_id when you only have the name.',
  inputSchema: {
    type: 'object',
    required: ['q'],
    properties: {
      q: { type: 'string', description: 'Free-form: a name ("Jane Q Smith"), an email, a user_name, or partial.' },
      limit: { type: 'number', description: 'Max rows. Default 5.' },
    },
    additionalProperties: false,
  },
  async run(rawArgs, processEnv) {
    const args = rawArgs as Args
    if (!args.q || !args.q.trim()) throw new SnowError('BAD_ARGS', 'find_user requires q.')
    const env = processEnv ? readEnv(processEnv) : undefined
    const limit = Math.min(Math.max(args.limit ?? 5, 1), 50)
    const fields = 'sys_id,user_name,name,first_name,last_name,email,active,company,department'
    const q = args.q.trim()
    const escaped = q.replace(/\^/g, ' ')

    // Build the strategy list. We stop at the first non-empty hit set.
    const strategies: string[] = []
    strategies.push(`active=true^name=${escaped}`)                 // 1. exact display name
    strategies.push(`active=true^email=${escaped}`)                // 2. exact email
    strategies.push(`active=true^user_name=${escaped}`)            // 3. exact sAMAccountName
    if (escaped.includes(' ')) {
      const parts = escaped.split(/\s+/)
      const first = parts[0]
      const last = parts[parts.length - 1]
      strategies.push(`active=true^first_nameSTARTSWITH${first}^last_name=${last}`) // 4. first + last
      strategies.push(`active=true^last_name=${last}^first_nameSTARTSWITH${first.charAt(0)}`) // 5. last + first initial
    }
    strategies.push(`active=true^nameLIKE${escaped}`)              // 6. partial name
    strategies.push(`nameLIKE${escaped}^ORemailLIKE${escaped}^ORuser_nameLIKE${escaped}`) // 7. inactive too, partial across fields

    for (const sysparm_query of strategies) {
      const res = await snowRequest<{ result: Record<string, unknown>[] }>('/table/sys_user', {
        env,
        query: { sysparm_query, sysparm_fields: fields, sysparm_limit: limit },
      })
      const rows = res.result ?? []
      if (rows.length > 0) return { strategy: sysparm_query, count: rows.length, results: rows.map(flatten) }
    }
    return { strategy: null, count: 0, results: [] }
  },
}
