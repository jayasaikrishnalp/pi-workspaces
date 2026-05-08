/**
 * Tool registry for the hive-self MCP server. Each tool is a thin wrapper
 * around one or two HTTP calls back to the workspace API. The set covers
 * memory CRUD + skill CRUD + the new fuzzy patch endpoint.
 */

import { memoryList } from './memory-list.ts'
import { memoryRead } from './memory-read.ts'
import { memoryWrite } from './memory-write.ts'
import { memoryDelete } from './memory-delete.ts'
import { skillList } from './skill-list.ts'
import { skillRead } from './skill-read.ts'
import { skillCreate } from './skill-create.ts'
import { skillEdit } from './skill-edit.ts'
import { skillPatch } from './skill-patch.ts'

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<unknown>
}

export const TOOLS: ToolDef[] = [
  memoryList,
  memoryRead,
  memoryWrite,
  memoryDelete,
  skillList,
  skillRead,
  skillCreate,
  skillEdit,
  skillPatch,
]

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name)
}
