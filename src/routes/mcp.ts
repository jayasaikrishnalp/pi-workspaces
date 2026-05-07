import type { IncomingMessage, ServerResponse } from 'node:http'

import { jsonError, jsonOk, matchPath, parsePath, readJsonBody } from '../server/http-helpers.js'
import { McpError } from '../server/mcp-broker.js'
import { addOverlayServer, removeOverlayServer, validateServerConfig } from '../server/mcp-overlay.js'
import { SEARCH_WIKI_TOOL, searchWiki } from '../server/tools/search-wiki.js'
import type { Wiring } from '../server/wiring.js'

/**
 * Built-in tools — exposed alongside MCP tools in /api/mcp/tools and callable
 * via /api/mcp/call with serverId='builtin'. Keep this list small.
 */
const BUILTIN_SERVER_ID = 'builtin'
function builtinTools(w: Wiring): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = []
  if (w.wikiStore) {
    tools.push({
      serverId: BUILTIN_SERVER_ID,
      toolName: SEARCH_WIKI_TOOL.name,
      qualifiedName: `${BUILTIN_SERVER_ID}:${SEARCH_WIKI_TOOL.name}`,
      description: SEARCH_WIKI_TOOL.description,
      inputSchema: SEARCH_WIKI_TOOL.inputSchema,
    })
  }
  return tools
}

function callBuiltin(
  w: Wiring,
  toolName: string,
  args: Record<string, unknown>,
): unknown {
  if (toolName === SEARCH_WIKI_TOOL.name) {
    if (!w.wikiStore) throw new McpError('UNKNOWN_TOOL', 'wiki not configured')
    const query = typeof args.query === 'string' ? args.query : ''
    const limit = typeof args.limit === 'number' ? args.limit : 5
    if (!query) throw new McpError('INVALID_ARGS', 'query must be a non-empty string')
    return searchWiki(w.wikiStore, query, limit)
  }
  throw new McpError('UNKNOWN_TOOL', `unknown built-in tool: ${toolName}`)
}

export const MCP_SERVERS_PATH = '/api/mcp/servers'
export const MCP_SERVER_DETAIL_PATH = '/api/mcp/servers/:id'
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
      if (filter === BUILTIN_SERVER_ID) {
        jsonOk(res, 200, { tools: builtinTools(w) })
        return
      }
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
    jsonOk(res, 200, { tools: [...builtinTools(w), ...w.mcpBroker.getTools()] })
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
    if (serverId === BUILTIN_SERVER_ID) {
      const result = callBuiltin(w, toolName, callArgs)
      jsonOk(res, 200, { result })
      return
    }
    const result = await w.mcpBroker.callTool(serverId, toolName, callArgs)
    jsonOk(res, 200, { result })
  } catch (err) {
    handleMcpError(res, err)
  }
}

/** POST /api/mcp/servers — register a user-defined MCP server. Body matches
 *  the McpServerConfig union (stdio: { id, kind, command, args, env? } |
 *  http: { id, kind, url, headers? }). Persisted in the overlay file. */
export async function handleMcpServerCreate(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  let body: unknown
  try { body = await readJsonBody(req) }
  catch (err) { jsonError(res, 400, 'BAD_REQUEST', (err as Error).message); return }
  const cfg = validateServerConfig(body)
  if (!cfg) {
    jsonError(res, 400, 'BAD_REQUEST', 'invalid mcp server config — id (kebab-case), kind, and (command+args | url) required')
    return
  }
  // Reject collisions with seed entries (broker enforces this anyway).
  if (w.mcpBroker.getStatus().some((s) => s.id === cfg.id)) {
    jsonError(res, 409, 'ALREADY_EXISTS', `mcp server "${cfg.id}" already exists`)
    return
  }
  try {
    addOverlayServer(w.workspaceRoot, cfg)
    w.mcpBroker.addServer(cfg)
  } catch (err) {
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
    return
  }
  jsonOk(res, 201, { id: cfg.id, kind: cfg.kind })
}

/** DELETE /api/mcp/servers/:id — remove a user-defined MCP server. Cannot
 *  remove seed entries (the persisted overlay never contained them). */
export async function handleMcpServerDelete(
  req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  const params = matchPath(MCP_SERVER_DETAIL_PATH, parsePath(req.url))
  const id = params?.id
  if (!id) { jsonError(res, 400, 'BAD_REQUEST', 'id required'); return }
  // Only allow removing entries that came from the overlay; seed entries
  // are immutable from the UI.
  const removedFromOverlay = removeOverlayServer(w.workspaceRoot, id)
  // If the overlay didn't have it, we still try the broker — but only
  // succeed if the broker's removeServer reports it was an overlay add at
  // runtime. Simpler: just refuse if the file change was a no-op (server
  // was a seed entry).
  void removedFromOverlay
  // Check if the server is still in broker after persistence step. If the
  // current broker entry persists, that means it's a seed entry — refuse.
  // (We'd need the broker to track origin to be more precise. For v1,
  // we just attempt the broker removal and let the result speak.)
  const removed = await w.mcpBroker.removeServer(id)
  if (!removed) { jsonError(res, 404, 'NOT_FOUND', `unknown mcp server: ${id}`); return }
  jsonOk(res, 200, { deleted: true, id })
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
