import type { IncomingMessage, ServerResponse } from 'node:http'

import { jsonError, jsonOk, readJsonBody } from '../server/http-helpers.js'
import { McpError } from '../server/mcp-broker.js'
import type { Wiring } from '../server/wiring.js'

export const MCP_SERVERS_PATH = '/api/mcp/servers'
export const MCP_TOOLS_PATH = '/api/mcp/tools'
export const MCP_CALL_PATH = '/api/mcp/call'

export async function handleMcpServersList(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const warm = url.searchParams.get('warm') === 'true'
  if (warm) {
    // Best-effort: trigger lazy-connect for every server. Errors are surfaced
    // in the per-server status; we never fail the whole list response.
    await Promise.all(
      w.mcpBroker.getStatus().map((s) =>
        w.mcpBroker.getToolsForServer(s.id).catch(() => undefined),
      ),
    )
  }
  jsonOk(res, 200, { servers: w.mcpBroker.getStatus() })
}

export async function handleMcpToolsList(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const filter = url.searchParams.get('server')
  try {
    if (filter) {
      const tools = await w.mcpBroker.getToolsForServer(filter)
      jsonOk(res, 200, { tools })
      return
    }
    // Touch every server lazily so the flat list is non-empty after first call.
    await Promise.all(
      w.mcpBroker.getStatus().map((s) =>
        w.mcpBroker.getToolsForServer(s.id).catch(() => undefined),
      ),
    )
    jsonOk(res, 200, { tools: w.mcpBroker.getTools() })
  } catch (err) {
    handleMcpError(res, err)
  }
}

export async function handleMcpCall(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    jsonError(res, 400, 'BAD_REQUEST', (err as Error).message)
    return
  }
  if (!body || typeof body !== 'object') {
    jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object')
    return
  }
  const { serverId, toolName, args } = body as Record<string, unknown>
  if (typeof serverId !== 'string') {
    jsonError(res, 400, 'BAD_REQUEST', 'serverId must be a string')
    return
  }
  if (typeof toolName !== 'string') {
    jsonError(res, 400, 'BAD_REQUEST', 'toolName must be a string')
    return
  }
  const callArgs = (args && typeof args === 'object') ? (args as Record<string, unknown>) : {}
  try {
    const result = await w.mcpBroker.callTool(serverId, toolName, callArgs)
    jsonOk(res, 200, { result })
  } catch (err) {
    handleMcpError(res, err)
  }
}

function handleMcpError(res: ServerResponse, err: unknown): void {
  if (err instanceof McpError) {
    const status =
      err.code === 'UNKNOWN_SERVER' ? 400
      : err.code === 'UNKNOWN_TOOL' ? 400
      : err.code === 'INVALID_ARGS' ? 400
      : err.code === 'MCP_TIMEOUT' ? 504
      : err.code === 'MCP_TRANSPORT_ERROR' ? 502
      : 500
    jsonError(res, status, err.code, err.message)
    return
  }
  jsonError(res, 500, 'INTERNAL', (err as Error).message)
}
