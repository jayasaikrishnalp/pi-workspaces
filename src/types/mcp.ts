export type McpServerKind = 'stdio' | 'http'

export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type McpServerConfig =
  | {
      id: string
      kind: 'stdio'
      command: string
      args: string[]
      env?: Record<string, string>
    }
  | {
      id: string
      kind: 'http'
      url: string
      headers?: Record<string, string>
    }

export interface McpServerStatus {
  id: string
  kind: McpServerKind
  status: McpConnectionStatus
  toolCount: number
  error?: string
  startedAt?: number
}

export interface Tool {
  name: string
  description?: string
  inputSchema: unknown
}

export interface QualifiedTool {
  serverId: string
  toolName: string
  qualifiedName: string
  description?: string
  inputSchema: unknown
}
