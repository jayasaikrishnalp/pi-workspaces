#!/usr/bin/env -S node --import tsx
/**
 * ServiceNow MCP stdio server.
 *
 * Speaks the MCP protocol over stdin/stdout using the official SDK's
 * low-level Server class so we can keep the tool registry as plain
 * JSON Schema (no zod). Reads SNOW_INSTANCE / SNOW_USER / SNOW_PASS
 * from process.env on every tool call — never caches creds — so a
 * Hive Secrets rotation lands on the next request without restarting.
 *
 * The server exposes 11 tools (see ./tools/_registry.ts). It is launched
 * by the workspace as a child process (mcp-config.ts wires it in when
 * SNOW_* secrets exist) and bridged into pi by the mcp-bridge extension.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { TOOLS, findTool } from './tools/_registry.ts'
import { SnowError } from './snow-client.ts'

async function main(): Promise<void> {
  const server = new Server(
    { name: 'servicenow', version: '0.1.0' },
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
      const result = await tool.run(args, process.env)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    } catch (err) {
      const message = err instanceof SnowError
        ? `[${err.code}] ${err.message}`
        : err instanceof Error ? err.message : String(err)
      return {
        isError: true,
        content: [{ type: 'text', text: message }],
      }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Keep the process alive — StdioServerTransport closes on stdin EOF
  // and that closure terminates the event loop. Nothing else to do.
}

main().catch((err) => {
  console.error('servicenow-mcp fatal:', err)
  process.exit(1)
})
