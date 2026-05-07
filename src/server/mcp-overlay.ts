/**
 * User-defined MCP servers — appended to the seed catalog at boot and
 * runtime. Persisted as JSON at <workspaceRoot>/mcp-servers.json so
 * "+ Add MCP server" entries survive restart.
 *
 *   {
 *     "servers": [
 *       { "id": "my-tool", "kind": "stdio", "command": "uvx", "args": ["my-tool"], "env": {} }
 *     ]
 *   }
 */
import fs from 'node:fs'
import path from 'node:path'

import type { McpServerConfig } from '../types/mcp.js'

export const OVERLAY_FILENAME = 'mcp-servers.json'

export function overlayPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, OVERLAY_FILENAME)
}

/** Load any user-defined entries. Missing file / parse error → empty list
 *  (we don't crash the workspace on a typo). */
export function loadOverlay(workspaceRoot: string): McpServerConfig[] {
  const p = overlayPath(workspaceRoot)
  try {
    if (!fs.existsSync(p)) return []
    const raw = fs.readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as { servers?: unknown }
    if (!Array.isArray(parsed.servers)) return []
    const out: McpServerConfig[] = []
    for (const s of parsed.servers as unknown[]) {
      const validated = validateServerConfig(s)
      if (validated) out.push(validated)
    }
    return out
  } catch (err) {
    console.error(`[mcp-overlay] failed to load ${p}:`, (err as Error).message)
    return []
  }
}

/** Atomic save (tmp + rename) so a crash mid-write doesn't corrupt the file. */
export function saveOverlay(workspaceRoot: string, servers: McpServerConfig[]): void {
  const p = overlayPath(workspaceRoot)
  const dir = path.dirname(p)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ servers }, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)
}

/** Append a new server. Throws if the id collides with an existing entry. */
export function addOverlayServer(workspaceRoot: string, cfg: McpServerConfig): McpServerConfig[] {
  const current = loadOverlay(workspaceRoot)
  if (current.some((c) => c.id === cfg.id)) {
    throw new Error(`mcp server id "${cfg.id}" already exists in overlay`)
  }
  const next = [...current, cfg]
  saveOverlay(workspaceRoot, next)
  return next
}

/** Remove an entry by id. Returns the new list (empty if it wasn't present). */
export function removeOverlayServer(workspaceRoot: string, id: string): McpServerConfig[] {
  const current = loadOverlay(workspaceRoot)
  const next = current.filter((c) => c.id !== id)
  if (next.length !== current.length) saveOverlay(workspaceRoot, next)
  return next
}

/** Validate one entry from the JSON. Returns null on shape error so we
 *  can skip bad rows without nuking the whole overlay. */
export function validateServerConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(r.id)) return null
  if (r.kind === 'stdio') {
    if (typeof r.command !== 'string' || !Array.isArray(r.args)) return null
    if (!r.args.every((a) => typeof a === 'string')) return null
    const env = r.env && typeof r.env === 'object'
      ? Object.fromEntries(Object.entries(r.env as Record<string, unknown>).filter(([_, v]) => typeof v === 'string')) as Record<string, string>
      : undefined
    return {
      id: r.id, kind: 'stdio',
      command: r.command, args: r.args as string[],
      ...(env ? { env } : {}),
    }
  }
  if (r.kind === 'http') {
    if (typeof r.url !== 'string') return null
    const headers = r.headers && typeof r.headers === 'object'
      ? Object.fromEntries(Object.entries(r.headers as Record<string, unknown>).filter(([_, v]) => typeof v === 'string')) as Record<string, string>
      : undefined
    return {
      id: r.id, kind: 'http',
      url: r.url,
      ...(headers ? { headers } : {}),
    }
  }
  return null
}
