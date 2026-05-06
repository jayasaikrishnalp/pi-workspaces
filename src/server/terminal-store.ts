import type { Db } from './db.js'

export type TerminalStatus = 'running' | 'completed' | 'timeout' | 'killed' | 'error'

export interface TerminalRow {
  id: string
  command: string
  cwd: string
  exit_code: number | null
  stdout: string | null
  stderr: string | null
  status: TerminalStatus
  started_at: number
  ended_at: number | null
  duration_ms: number | null
  created_by: string | null
}

export class TerminalStore {
  constructor(private readonly db: Db) {}

  start(id: string, command: string, cwd: string, createdBy?: string): TerminalRow {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO terminal_executions (id, command, cwd, status, started_at, created_by)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(id, command, cwd, now, createdBy ?? null)
    return this.get(id)!
  }

  complete(
    id: string,
    out: { status: Exclude<TerminalStatus, 'running'>; exitCode: number | null; stdout: string; stderr: string; durationMs: number },
  ): TerminalRow {
    const endedAt = Date.now()
    this.db.prepare(`
      UPDATE terminal_executions SET
        status = ?, exit_code = ?, stdout = ?, stderr = ?,
        ended_at = ?, duration_ms = ?
      WHERE id = ?
    `).run(out.status, out.exitCode, out.stdout, out.stderr, endedAt, out.durationMs, id)
    return this.get(id)!
  }

  get(id: string): TerminalRow | null {
    return (this.db.prepare('SELECT * FROM terminal_executions WHERE id = ?').get(id) as TerminalRow | undefined) ?? null
  }

  list(opts: { limit?: number; before?: number } = {}): TerminalRow[] {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
    if (typeof opts.before === 'number') {
      return this.db.prepare(
        'SELECT * FROM terminal_executions WHERE started_at < ? ORDER BY started_at DESC LIMIT ?',
      ).all(opts.before, limit) as TerminalRow[]
    }
    return this.db.prepare(
      'SELECT * FROM terminal_executions ORDER BY started_at DESC LIMIT ?',
    ).all(limit) as TerminalRow[]
  }

  totalCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM terminal_executions').get() as { c: number }).c
  }
}
