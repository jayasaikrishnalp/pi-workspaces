import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { McpServerConfig } from '../types/mcp.js'

/**
 * Resolve the Ref API key with this precedence:
 *   1. process.env.REF_API_KEY
 *   2. In-memory lift from ~/.claude.json at mcpServers.Ref.headers["x-ref-api-key"]
 *
 * The lift is best-effort — a missing or malformed file MUST NOT throw. The
 * lifted value is NEVER persisted by this workspace.
 */
export function resolveRefApiKey(env: NodeJS.ProcessEnv = process.env, claudeJsonPath = path.join(os.homedir(), '.claude.json')): string | null {
  const fromEnv = env.REF_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv

  try {
    const raw = fs.readFileSync(claudeJsonPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const mcpServers = parsed.mcpServers as Record<string, unknown> | undefined
    const ref = mcpServers?.Ref as { headers?: Record<string, string> } | undefined
    const lifted = ref?.headers?.['x-ref-api-key']
    if (typeof lifted === 'string' && lifted.length > 0) return lifted
  } catch {
    // best-effort — any error means "no key", workspace boots normally
  }
  return null
}

/**
 * The hardcoded v1 catalog. Multi-server config (add/remove/enable/disable)
 * lands with the frontend Settings tab.
 */
export function loadSeedConfig(env: NodeJS.ProcessEnv = process.env): McpServerConfig[] {
  const refKey = resolveRefApiKey(env)
  const catalog: McpServerConfig[] = [
    {
      id: 'ref',
      kind: 'http',
      url: 'https://api.ref.tools/mcp',
      ...(refKey ? { headers: { 'x-ref-api-key': refKey } } : {}),
    },
    {
      id: 'context7',
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      env: {},
    },
  ]
  return catalog
}

/**
 * Returns a label that explains why a Ref entry has no key, for use in
 * McpServerStatus.error when the broker tries to connect Ref without a key.
 */
export function refKeyMissingMessage(): string {
  return 'REF_API_KEY not set; lift from ~/.claude.json mcpServers.Ref.headers["x-ref-api-key"] returned no value'
}
