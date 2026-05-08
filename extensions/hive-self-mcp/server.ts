#!/usr/bin/env -S node --import tsx
/**
 * Hive self MCP server — exposes the workspace's own /api/memory and
 * /api/skills endpoints as native MCP tools so pi can manage skills +
 * memory without shelling out to curl.
 *
 * 9 tools (see ./tools/_registry.ts):
 *   memory_list / memory_read / memory_write / memory_delete
 *   skill_list / skill_read / skill_create / skill_edit / skill_patch
 *
 * Auth: every call reads WORKSPACE_INTERNAL_TOKEN from env at request time
 * (no caching — token rotation lands on the next call without restart).
 *
 * Process model: launched by the workspace as a stdio MCP child via tsx,
 * registered in mcp-config.ts. Bridged into pi by the existing
 * extensions/mcp-bridge as `mcp__hive_self__*` tools.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { TOOLS, findTool } from './tools/_registry.ts'
import { HiveError } from './http-client.ts'

async function main(): Promise<void> {
  const server = new Server(
    { name: 'hive-self', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    const tool = findTool(name)
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
      }
    }
    try {
      const result = await tool.run(args)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      const message = err instanceof HiveError
        ? `[${err.code}] ${err.message}`
        : err instanceof Error ? err.message : String(err)
      return { isError: true, content: [{ type: 'text', text: message }] }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('hive-self-mcp fatal:', err)
  process.exit(1)
})
