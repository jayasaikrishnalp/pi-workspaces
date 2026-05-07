import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { McpServerConfig } from '../types/mcp.js'
import { buildSecretEnv, type SecretReader } from './secret-store.js'

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
 *
 * Phase 3: when a SecretReader is provided, AWS / ARM / AZURE env vars
 * derived from `aws.` / `azure.` secret prefixes are merged into each
 * stdio server's child env. Future MCP servers like aws-mcp / terraform-mcp
 * pick them up automatically through the existing process.env spread merge
 * in StdioMcpClient.
 */
/** Locate `uvx` (the binary that runs `uvx mcp-atlassian`) without
 *  hard-coding /opt/homebrew. Resolves via $PATH; returns null when not
 *  found so callers can skip registering atlassian. */
function findUvx(env: NodeJS.ProcessEnv): string | null {
  const fromEnv = env.UVX_BIN
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv
  const dirs = (env.PATH ?? '').split(':')
  for (const d of dirs) {
    const candidate = path.join(d, 'uvx')
    try { if (fs.statSync(candidate).isFile()) return candidate } catch { /* skip */ }
  }
  return null
}

export function loadSeedConfig(
  env: NodeJS.ProcessEnv = process.env,
  secretStore?: SecretReader | null,
): McpServerConfig[] {
  const refKey = resolveRefApiKey(env)
  const secretEnv = secretStore ? buildSecretEnv(secretStore) : {}
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
      env: { ...secretEnv },
    },
  ]

  // Atlassian (Jira + Confluence) MCP server. Only registered when:
  //   - uvx is installed (PATH search or UVX_BIN env)
  //   - The secret store has at least one of (CONFLUENCE_URL || JIRA_URL)
  //     so the broker doesn't try to start a server with no creds.
  // The mcp-atlassian package reads CONFLUENCE_URL / CONFLUENCE_USERNAME /
  // CONFLUENCE_API_TOKEN / JIRA_URL / JIRA_USERNAME / JIRA_API_TOKEN from
  // env, all of which the secret store passes through verbatim now that
  // flat-key passthrough is in place.
  const uvx = findUvx(env)
  const hasAtlassianCreds = !!(secretEnv.CONFLUENCE_URL || secretEnv.JIRA_URL)
  if (uvx && hasAtlassianCreds) {
    catalog.push({
      id: 'atlassian',
      kind: 'stdio',
      command: uvx,
      args: ['mcp-atlassian'],
      env: { ...secretEnv },
    })
  }

  // ServiceNow MCP. Locally hosted server under extensions/servicenow-mcp,
  // launched via tsx. Gated on all three SNOW_* secrets being present —
  // anything less and the broker would just fail with NO_CREDS on every call.
  const hasSnowCreds = !!(secretEnv.SNOW_INSTANCE && secretEnv.SNOW_USER && secretEnv.SNOW_PASS)
  if (hasSnowCreds) {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
    catalog.push({
      id: 'servicenow',
      kind: 'stdio',
      command: process.execPath,
      args: ['--import', 'tsx', path.join(repoRoot, 'extensions/servicenow-mcp/server.ts')],
      env: { ...secretEnv },
    })
  }

  return catalog
}

/**
 * Returns a label that explains why a Ref entry has no key, for use in
 * McpServerStatus.error when the broker tries to connect Ref without a key.
 */
export function refKeyMissingMessage(): string {
  return 'REF_API_KEY not set; lift from ~/.claude.json mcpServers.Ref.headers["x-ref-api-key"] returned no value'
}
