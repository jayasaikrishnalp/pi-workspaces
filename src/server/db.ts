import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

import Database, { type Database as DbType } from 'better-sqlite3'

/**
 * Single-file SQLite database for the cloudops-workspace.
 *
 * - WAL journal mode (concurrent reads + serialized writes via the WAL).
 * - synchronous=NORMAL (durable enough; full sync only at WAL checkpoints).
 * - foreign_keys=ON.
 * - Hand-rolled additive migrations under db-migrations/NNN_*.sql, applied in
 *   order on every connection open. Idempotent. Adapted from the Hermes
 *   pattern (`hermes_cli/kanban_db.py::_migrate_add_optional_columns`).
 */

export type Db = DbType

export function openDb(filePath: string): Db {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  // 5s busy timeout — we serialize writes through small store classes, so
  // contention is rare; this is belt-and-braces for tests and CI.
  db.pragma('busy_timeout = 5000')
  applyMigrations(db)
  return db
}

const MIGRATIONS_DIR = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  'db-migrations',
)

function applyMigrations(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)
  const current = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
  for (const f of files) {
    const m = /^(\d+)_/.exec(f)
    if (!m) continue
    const version = Number(m[1])
    if (version <= current) continue
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')
    const tx = db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now())
    })
    tx()
  }
}

export function getSchemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
  return row.v ?? 0
}

/**
 * Upsert a kb_fts row for an on-disk markdown body. Called from the
 * kb-watcher when a file is added/changed under <kbRoot>/{skills,agents,
 * workflows,memory,souls}/.
 */
export function upsertKbFts(db: Db, kind: string, name: string, body: string): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM kb_fts WHERE kind = ? AND name = ?").run(kind, name)
    db.prepare("DELETE FROM kb_fts_trigram WHERE kind = ? AND name = ?").run(kind, name)
    db.prepare("INSERT INTO kb_fts (kind, name, body) VALUES (?, ?, ?)").run(kind, name, body)
    db.prepare("INSERT INTO kb_fts_trigram (kind, name, body) VALUES (?, ?, ?)").run(kind, name, body)
  })
  tx()
}

export function deleteKbFts(db: Db, kind: string, name: string): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM kb_fts WHERE kind = ? AND name = ?").run(kind, name)
    db.prepare("DELETE FROM kb_fts_trigram WHERE kind = ? AND name = ?").run(kind, name)
  })
  tx()
}

export function clearKbFts(db: Db): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM kb_fts').run()
    db.prepare('DELETE FROM kb_fts_trigram').run()
  })
  tx()
}
