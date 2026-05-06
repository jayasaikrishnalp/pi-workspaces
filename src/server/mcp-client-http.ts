import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import type { Tool } from '../types/mcp.js'

const CLIENT_INFO = { name: 'cloudops-workspace', version: '0.1.0' }

export class HttpMcpClient {
  private client: Client | null = null
  private transport: StreamableHTTPClientTransport | null = null

  constructor(
    private readonly id: string,
    private readonly opts: { url: string; headers?: Record<string, string> },
  ) {}

  async start(): Promise<void> {
    if (this.client) return
    const transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
      requestInit: this.opts.headers ? { headers: this.opts.headers } : undefined,
    })
    const client = new Client(CLIENT_INFO, { capabilities: {} })
    await client.connect(transport)
    this.client = client
    this.transport = transport
  }

  async listTools(): Promise<Tool[]> {
    if (!this.client) throw new Error(`mcp client ${this.id} not started`)
    const res = await this.client.listTools()
    return (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!this.client) throw new Error(`mcp client ${this.id} not started`)
    return this.client.callTool({ name, arguments: args }, undefined, { signal })
  }

  async shutdown(): Promise<void> {
    const client = this.client
    const transport = this.transport
    this.client = null
    this.transport = null
    if (transport) {
      try { await transport.close() } catch { /* swallow */ }
    }
    if (client) {
      try { await client.close() } catch { /* swallow */ }
    }
  }
}
