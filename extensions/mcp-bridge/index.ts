/**
 * cloudops-workspace · pi extension: mcp-bridge
 *
 * Reads the workspace port from ~/.pi-workspace/server.port, fetches the flat
 * tool list from /api/mcp/tools, and registers each MCP tool with pi as
 *   mcp__<serverId>__<toolName>
 *
 * Each registered tool's handler does POST /api/mcp/call.
 *
 * Failure modes — none of these crash pi:
 *   - port file missing      → log warning, exit cleanly, no tools registered
 *   - backend unreachable    → log warning, exit cleanly, no tools registered
 *   - tools list empty       → log info, exit cleanly
 *
 * Copy this file to ~/.pi/agent/extensions/mcp-bridge/ via start.sh.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface PiLike {
  on(event: 'startup' | 'resources_discover', cb: () => void | Promise<void>): void
  registerTool(name: string, def: unknown): void
}

interface QualifiedTool {
  serverId: string
  toolName: string
  qualifiedName: string
  description?: string
  inputSchema: unknown
}

const PORT_FILE = path.join(os.homedir(), '.pi-workspace', 'server.port')

function readPort(): number | null {
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf8').trim()
    const n = Number(raw)
    if (!Number.isInteger(n) || n <= 0 || n > 65_535) return null
    return n
  } catch {
    return null
  }
}

async function fetchTools(baseUrl: string): Promise<QualifiedTool[]> {
  const res = await fetch(`${baseUrl}/api/mcp/tools`)
  if (!res.ok) throw new Error(`tools list returned ${res.status}`)
  const body = (await res.json()) as { tools?: QualifiedTool[] }
  return body.tools ?? []
}

async function callTool(baseUrl: string, serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${baseUrl}/api/mcp/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId, toolName, args }),
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) {
    const code = (payload as { error?: { code?: string } }).error?.code ?? 'INTERNAL'
    const msg = (payload as { error?: { message?: string } }).error?.message ?? `mcp call failed (${res.status})`
    throw new Error(`${code}: ${msg}`)
  }
  return (payload as { result?: unknown }).result
}

async function registerAll(pi: PiLike, baseUrl: string): Promise<void> {
  let tools: QualifiedTool[]
  try {
    tools = await fetchTools(baseUrl)
  } catch (err) {
    console.warn(`[mcp-bridge] backend unreachable at ${baseUrl}: ${(err as Error).message}`)
    return
  }
  if (tools.length === 0) {
    console.info('[mcp-bridge] backend reported zero MCP tools (no servers connected yet)')
    return
  }
  for (const t of tools) {
    const piToolName = `mcp__${t.serverId}__${t.toolName}`
    pi.registerTool(piToolName, {
      description: t.description ?? `MCP tool ${t.qualifiedName}`,
      inputSchema: t.inputSchema,
      handler: async (args: Record<string, unknown>) => callTool(baseUrl, t.serverId, t.toolName, args),
    })
  }
  console.info(`[mcp-bridge] registered ${tools.length} MCP tool(s) from ${baseUrl}`)
}

export default function activate(pi: PiLike): void {
  pi.on('startup', async () => {
    const port = readPort()
    if (port === null) {
      console.warn(`[mcp-bridge] port file ${PORT_FILE} missing or unreadable; skipping`)
      return
    }
    await registerAll(pi, `http://127.0.0.1:${port}`)
  })

  // Re-register if the workspace adds servers later.
  pi.on('resources_discover', async () => {
    const port = readPort()
    if (port === null) return
    await registerAll(pi, `http://127.0.0.1:${port}`)
  })
}
