import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import type { Tool } from '../types/mcp.js'

const CLIENT_INFO = { name: 'cloudops-workspace', version: '0.1.0' }

export class StdioMcpClient {
  private client: Client | null = null
  private transport: StdioClientTransport | null = null

  constructor(
    private readonly id: string,
    private readonly opts: { command: string; args: string[]; env?: Record<string, string> },
  ) {}

  async start(): Promise<void> {
    if (this.client) return
    const transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args,
      env: { ...process.env as Record<string, string>, ...(this.opts.env ?? {}) },
      stderr: 'pipe',
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
    const res = await this.client.callTool({ name, arguments: args }, undefined, { signal })
    return res
  }

  async shutdown(): Promise<void> {
    const client = this.client
    const transport = this.transport
    this.client = null
    this.transport = null
    if (transport) {
      try {
        await Promise.race([
          transport.close(),
          new Promise<void>((resolve) => setTimeout(resolve, 1_000).unref()),
        ])
      } catch { /* swallow */ }
    }
    if (client) {
      try { await client.close() } catch { /* swallow */ }
    }
  }
}
