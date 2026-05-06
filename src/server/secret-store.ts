import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Per-workspace secret store. File-backed JSON at <workspaceRoot>/secrets.json.
 *
 * Modeled after AuthStore: same singleton + atomic-tmp+rename pattern, same
 * 0o600 file mode. No encryption-at-rest in v1 — that's a separate concern
 * (probably tied to OS keyring) and the file is workspace-local.
 *
 * Storage shape (one secret per key):
 *
 *     { "<key>": { "value": "<string>", "updatedAt": <epoch ms> } }
 */

const MAX_KEY_LEN = 256

export interface SecretStoreOptions {
  workspaceRoot: string
}

interface SecretRow {
  value: string
  updatedAt: number
}

export class SecretStore {
  private readonly secretsPath: string
  private secrets = new Map<string, SecretRow>()
  private loaded = false

  constructor(opts: SecretStoreOptions) {
    this.secretsPath = path.join(opts.workspaceRoot, 'secrets.json')
  }

  /** Load the on-disk store. Idempotent. Corrupt JSON boots clean. */
  async load(): Promise<void> {
    if (this.loaded) return
    await fs.mkdir(path.dirname(this.secretsPath), { recursive: true })
    try {
      const raw = await fs.readFile(this.secretsPath, 'utf8')
      const data = JSON.parse(raw) as Record<string, SecretRow>
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && typeof v.value === 'string' && typeof v.updatedAt === 'number') {
          this.secrets.set(k, { value: v.value, updatedAt: v.updatedAt })
        }
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        // First run; nothing to load.
      } else {
        // Corrupt file — log and start fresh. The next persist() will overwrite it.
        console.error('[secret-store] secrets.json unreadable; starting fresh:', err)
      }
    }
    this.loaded = true
  }

  /**
   * Set a secret. Trims whitespace from key. Overwrites any existing value.
   * Throws on empty key, key > MAX_KEY_LEN, or non-string value.
   */
  async setSecret(key: string, value: string): Promise<void> {
    if (typeof value !== 'string') {
      throw new Error('secret value must be a string')
    }
    const trimmed = typeof key === 'string' ? key.trim() : ''
    if (trimmed.length === 0) {
      throw new Error('secret key must be a non-empty string')
    }
    if (trimmed.length > MAX_KEY_LEN) {
      throw new Error(`secret key too long (max ${MAX_KEY_LEN})`)
    }
    this.secrets.set(trimmed, { value, updatedAt: Date.now() })
    await this.persist()
  }

  /** Get a secret value. Trims whitespace from key for symmetry with setSecret. */
  getSecret(key: string): string | undefined {
    const trimmed = typeof key === 'string' ? key.trim() : ''
    if (trimmed.length === 0) return undefined
    return this.secrets.get(trimmed)?.value
  }

  /**
   * List secret keys with their updatedAt timestamps. **Never includes values.**
   * Sorted alphabetically by key for stable UI display.
   */
  listKeys(): Array<{ key: string; updatedAt: number }> {
    return Array.from(this.secrets.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, row]) => ({ key, updatedAt: row.updatedAt }))
  }

  /** Remove a secret. Returns true if the key existed, false otherwise. */
  async deleteSecret(key: string): Promise<boolean> {
    const trimmed = typeof key === 'string' ? key.trim() : ''
    if (trimmed.length === 0) return false
    if (!this.secrets.delete(trimmed)) return false
    await this.persist()
    return true
  }

  /**
   * Bulk lookup for env-injection consumers (e.g. mcp-config.ts and the
   * hive-secrets pi extension): return all secret values whose key starts
   * with `prefix`. Empty prefix returns everything.
   */
  getByPrefix(prefix: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, row] of this.secrets) {
      if (k.startsWith(prefix)) out[k] = row.value
    }
    return out
  }

  /** Atomic write: tmp + rename. Mode 0o600 — secrets must not leak via fs. */
  private async persist(): Promise<void> {
    const data: Record<string, SecretRow> = {}
    for (const [k, v] of this.secrets) data[k] = v
    const tmp = `${this.secretsPath}.tmp.${process.pid}.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await fs.rename(tmp, this.secretsPath)
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __secretStore: SecretStore | undefined
}

export function getSecretStore(opts: SecretStoreOptions): SecretStore {
  if (!globalThis.__secretStore) globalThis.__secretStore = new SecretStore(opts)
  return globalThis.__secretStore
}

export function _resetSecretStoreForTests(): void {
  globalThis.__secretStore = undefined
}
