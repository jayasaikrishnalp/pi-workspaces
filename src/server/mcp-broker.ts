import type {
  McpConnectionStatus,
  McpServerConfig,
  McpServerStatus,
  QualifiedTool,
  Tool,
} from '../types/mcp.js'
import { HttpMcpClient } from './mcp-client-http.js'
import { StdioMcpClient } from './mcp-client-stdio.js'
import { refKeyMissingMessage } from './mcp-config.js'

export type McpClientLike = {
  start(): Promise<void>
  listTools(): Promise<Tool[]>
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  shutdown(): Promise<void>
}

export type ClientFactory = (cfg: McpServerConfig) => McpClientLike

export class McpError extends Error {
  constructor(public code: McpErrorCode, message: string) {
    super(message)
    this.name = 'McpError'
  }
}

export type McpErrorCode =
  | 'UNKNOWN_SERVER'
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGS'
  | 'MCP_TRANSPORT_ERROR'
  | 'MCP_TIMEOUT'
  | 'INTERNAL'

interface ServerEntry {
  config: McpServerConfig
  client: McpClientLike | null
  status: McpConnectionStatus
  error?: string
  startedAt?: number
  toolCache: Tool[] | null
  connectingPromise: Promise<void> | null
}

export const DEFAULT_CALL_TIMEOUT_MS = 30_000

export class McpBroker {
  private servers: Map<string, ServerEntry> = new Map()

  constructor(
    configs: McpServerConfig[],
    private readonly factory: ClientFactory = defaultFactory,
  ) {
    for (const cfg of configs) {
      this.servers.set(cfg.id, {
        config: cfg,
        client: null,
        status: 'disconnected',
        toolCache: null,
        connectingPromise: null,
      })
    }
  }

  getStatus(): McpServerStatus[] {
    return [...this.servers.values()].map((e) => ({
      id: e.config.id,
      kind: e.config.kind,
      status: e.status,
      toolCount: e.toolCache?.length ?? 0,
      ...(e.error ? { error: e.error } : {}),
      ...(e.startedAt ? { startedAt: e.startedAt } : {}),
    }))
  }

  /**
   * Returns the flat list of tools across all currently-connected servers.
   * Servers that are not yet connected are NOT auto-connected here. To warm a
   * specific server, call `getToolsForServer(id)`.
   */
  getTools(): QualifiedTool[] {
    const out: QualifiedTool[] = []
    for (const e of this.servers.values()) {
      if (e.status !== 'connected' || !e.toolCache) continue
      for (const t of e.toolCache) {
        out.push({
          serverId: e.config.id,
          toolName: t.name,
          qualifiedName: `${e.config.id}:${t.name}`,
          description: t.description,
          inputSchema: t.inputSchema,
        })
      }
    }
    return out
  }

  /**
   * Lazy-connects the named server (if not already), then returns its tools.
   */
  async getToolsForServer(serverId: string): Promise<QualifiedTool[]> {
    await this.ensureConnected(serverId)
    const e = this.servers.get(serverId)
    if (!e || !e.toolCache) return []
    return e.toolCache.map((t) => ({
      serverId,
      toolName: t.name,
      qualifiedName: `${serverId}:${t.name}`,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    const e = this.servers.get(serverId)
    if (!e) throw new McpError('UNKNOWN_SERVER', `unknown mcp server: ${serverId}`)
    await this.ensureConnected(serverId)
    if (!e.toolCache?.find((t) => t.name === toolName)) {
      throw new McpError('UNKNOWN_TOOL', `server ${serverId} has no tool ${toolName}`)
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    timer.unref()
    try {
      return await e.client!.callTool(toolName, args, ac.signal)
    } catch (err) {
      if (ac.signal.aborted) throw new McpError('MCP_TIMEOUT', `tool call exceeded ${timeoutMs}ms`)
      const msg = err instanceof Error ? err.message : String(err)
      throw new McpError('MCP_TRANSPORT_ERROR', msg)
    } finally {
      clearTimeout(timer)
    }
  }

  async shutdownAll(): Promise<void> {
    const tasks: Array<Promise<void>> = []
    for (const e of this.servers.values()) {
      const c = e.client
      e.client = null
      e.status = 'disconnected'
      e.toolCache = null
      e.connectingPromise = null
      if (c) tasks.push(c.shutdown().catch(() => {}))
    }
    await Promise.all(tasks)
  }

  private async ensureConnected(serverId: string): Promise<void> {
    const e = this.servers.get(serverId)
    if (!e) throw new McpError('UNKNOWN_SERVER', `unknown mcp server: ${serverId}`)
    if (e.status === 'connected') return
    if (e.connectingPromise) return e.connectingPromise

    // Pre-flight: Ref needs an API key. If missing, mark error and refuse to connect.
    if (e.config.id === 'ref' && e.config.kind === 'http' && !e.config.headers?.['x-ref-api-key']) {
      e.status = 'error'
      e.error = refKeyMissingMessage()
      throw new McpError('MCP_TRANSPORT_ERROR', e.error)
    }

    e.status = 'connecting'
    e.error = undefined
    const promise = (async () => {
      try {
        const client = this.factory(e.config)
        await client.start()
        const tools = await client.listTools()
        e.client = client
        e.toolCache = tools
        e.status = 'connected'
        e.startedAt = Date.now()
      } catch (err) {
        e.status = 'error'
        e.error = err instanceof Error ? err.message : String(err)
        e.client = null
        e.toolCache = null
        throw err
      } finally {
        e.connectingPromise = null
      }
    })()
    e.connectingPromise = promise
    try {
      await promise
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new McpError('MCP_TRANSPORT_ERROR', msg)
    }
  }
}

function defaultFactory(cfg: McpServerConfig): McpClientLike {
  if (cfg.kind === 'stdio') {
    return new StdioMcpClient(cfg.id, { command: cfg.command, args: cfg.args, env: cfg.env })
  }
  return new HttpMcpClient(cfg.id, { url: cfg.url, headers: cfg.headers })
}
