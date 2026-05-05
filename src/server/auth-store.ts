import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

/**
 * Single-user workspace auth: a fixed dev token + a session map.
 *
 * - Dev token lives at <root>/dev-token.txt (mode 0600). Generated on first
 *   boot if missing.
 * - Sessions live at <root>/sessions.json. One entry per active cookie.
 *   { sessionId: { createdAt: number } }
 */

export interface AuthStoreOptions {
  workspaceRoot: string
}

export class AuthStore {
  private readonly tokenPath: string
  private readonly sessionsPath: string
  private token: string | null = null
  private sessions = new Map<string, { createdAt: number }>()
  private loaded = false

  constructor(opts: AuthStoreOptions) {
    this.tokenPath = path.join(opts.workspaceRoot, 'dev-token.txt')
    this.sessionsPath = path.join(opts.workspaceRoot, 'sessions.json')
  }

  /**
   * Load token (creating it if missing) and session map. Idempotent.
   */
  async load(): Promise<void> {
    if (this.loaded) return
    await fs.mkdir(path.dirname(this.tokenPath), { recursive: true })
    try {
      this.token = (await fs.readFile(this.tokenPath, 'utf8')).trim()
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      this.token = randomBytes(24).toString('hex')
      await fs.writeFile(this.tokenPath, this.token + '\n', { mode: 0o600 })
    }
    try {
      const raw = await fs.readFile(this.sessionsPath, 'utf8')
      const data = JSON.parse(raw) as Record<string, { createdAt: number }>
      for (const [k, v] of Object.entries(data)) {
        this.sessions.set(k, v)
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        // Corrupt sessions.json — start fresh.
        console.error('[auth-store] sessions.json unreadable; starting fresh:', err)
      }
    }
    this.loaded = true
  }

  getToken(): string {
    if (!this.token) throw new Error('AUTH_STORE_NOT_LOADED')
    return this.token
  }

  /**
   * Verify a candidate token against the dev token. Constant-time comparison
   * to defend against timing attacks (single-user workspace, but cheap).
   */
  verifyToken(candidate: string): boolean {
    if (!this.token) return false
    if (typeof candidate !== 'string' || candidate.length !== this.token.length) return false
    let diff = 0
    for (let i = 0; i < this.token.length; i++) {
      diff |= this.token.charCodeAt(i) ^ candidate.charCodeAt(i)
    }
    return diff === 0
  }

  async createSession(): Promise<string> {
    const id = randomUUID()
    this.sessions.set(id, { createdAt: Date.now() })
    await this.persist()
    return id
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id)
  }

  async deleteSession(id: string): Promise<void> {
    if (!this.sessions.delete(id)) return
    await this.persist()
  }

  private async persist(): Promise<void> {
    const data: Record<string, { createdAt: number }> = {}
    for (const [k, v] of this.sessions) data[k] = v
    const tmp = `${this.sessionsPath}.tmp.${process.pid}.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await fs.rename(tmp, this.sessionsPath)
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __authStore: AuthStore | undefined
}

export function getAuthStore(opts: AuthStoreOptions): AuthStore {
  if (!globalThis.__authStore) globalThis.__authStore = new AuthStore(opts)
  return globalThis.__authStore
}
