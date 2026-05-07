/**
 * Tool registry for the servicenow MCP server.
 *
 * Each tool has a JSON Schema (not zod) since the MCP SDK accepts both
 * and JSON Schema is what the wire protocol uses anyway. The registry
 * is just an array — the server iterates it for `tools/list` and looks
 * up by name for `tools/call`.
 */

import { getIncident } from './get-incident.ts'
import { searchIncidents } from './search-incidents.ts'
import { createIncident } from './create-incident.ts'
import { updateIncident } from './update-incident.ts'
import { resolveIncident } from './resolve-incident.ts'
import { assignTicket } from './assign-ticket.ts'
import { findUser } from './find-user.ts'
import { findServer } from './find-server.ts'
import { getChangesForHost } from './get-changes-for-host.ts'
import { listTasksForCi } from './list-tasks-for-ci.ts'
import { getRitm } from './get-ritm.ts'

export interface ToolDef {
  name: string
  description: string
  /** JSON Schema describing the args object passed to `run`. */
  inputSchema: Record<string, unknown>
  /** Implementation. Receives args + env (so tests can stub env). */
  run: (args: Record<string, unknown>, env?: NodeJS.ProcessEnv) => Promise<unknown>
}

export const TOOLS: ToolDef[] = [
  getIncident,
  searchIncidents,
  createIncident,
  updateIncident,
  resolveIncident,
  assignTicket,
  findUser,
  findServer,
  getChangesForHost,
  listTasksForCi,
  getRitm,
]

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name)
}
