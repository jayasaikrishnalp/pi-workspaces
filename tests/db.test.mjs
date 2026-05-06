/**
 * SQLite foundation tests — fresh boot, idempotent re-open, pragmas, FTS5
 * triggers and kb_fts upserts.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openDb, getSchemaVersion, upsertKbFts, deleteKbFts, clearKbFts } from '../src/server/db.ts'

function tmp() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'data.sqlite')
}

test('openDb creates schema on fresh boot and advances version', () => {
  const db = openDb(tmp())
  try {
    assert.ok(getSchemaVersion(db) >= 1, 'at least one migration applied')
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' OR type='view'",
    ).all().map((r) => r.name).sort()
    for (const t of ['jobs', 'tasks', 'chat_messages', 'kb_fts', 'kb_fts_trigram', 'chat_fts', 'chat_fts_trigram', 'schema_version', 'terminal_executions']) {
      assert.ok(tables.includes(t), `expected table ${t}; got ${tables.join(',')}`)
    }
  } finally { db.close() }
})

test('openDb is idempotent — second open does not re-run migrations', () => {
  const p = tmp()
  const db1 = openDb(p)
  const v1 = getSchemaVersion(db1)
  db1.close()
  const db2 = openDb(p)
  try {
    assert.equal(getSchemaVersion(db2), v1)
    // Only one row in schema_version per applied migration.
    const rows = db2.prepare('SELECT version, COUNT(*) as c FROM schema_version GROUP BY version').all()
    for (const r of rows) assert.equal(r.c, 1)
  } finally { db2.close() }
})

test('pragmas: WAL + foreign_keys are set', () => {
  const db = openDb(tmp())
  try {
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  } finally { db.close() }
})

test('chat_messages trigger keeps chat_fts in sync', () => {
  const db = openDb(tmp())
  try {
    db.prepare("INSERT INTO chat_messages (id, run_id, role, content, created_at) VALUES (?,?,?,?,?)").run(
      'm1', 'r1', 'user', 'the quick brown fox', Date.now(),
    )
    const hit = db.prepare("SELECT rowid FROM chat_fts WHERE chat_fts MATCH 'fox'").get()
    assert.ok(hit, 'expected chat_fts to find "fox"')
    const sub = db.prepare("SELECT rowid FROM chat_fts_trigram WHERE chat_fts_trigram MATCH 'rown'").get()
    assert.ok(sub, 'expected trigram chat_fts to find substring "rown"')

    // Update — old word should disappear, new word should match.
    db.prepare("UPDATE chat_messages SET content = ? WHERE id = ?").run('lazy dog', 'm1')
    assert.equal(db.prepare("SELECT rowid FROM chat_fts WHERE chat_fts MATCH 'fox'").get(), undefined)
    assert.ok(db.prepare("SELECT rowid FROM chat_fts WHERE chat_fts MATCH 'lazy'").get())

    // Delete — index drops the row.
    db.prepare("DELETE FROM chat_messages WHERE id = ?").run('m1')
    assert.equal(db.prepare("SELECT rowid FROM chat_fts WHERE chat_fts MATCH 'lazy'").get(), undefined)
  } finally { db.close() }
})

test('upsertKbFts / deleteKbFts round-trip', () => {
  const db = openDb(tmp())
  try {
    upsertKbFts(db, 'skill', 'reboot-server', 'safely restart a Linux VM with snapshot fence')
    const hit = db.prepare("SELECT name FROM kb_fts WHERE kb_fts MATCH 'snapshot'").get()
    assert.equal(hit.name, 'reboot-server')

    // Re-upsert overwrites, no duplicate row.
    upsertKbFts(db, 'skill', 'reboot-server', 'completely different body about keepalive')
    const rows = db.prepare("SELECT name FROM kb_fts WHERE name = 'reboot-server'").all()
    assert.equal(rows.length, 1)
    assert.equal(db.prepare("SELECT name FROM kb_fts WHERE kb_fts MATCH 'snapshot'").get(), undefined)
    assert.ok(db.prepare("SELECT name FROM kb_fts WHERE kb_fts MATCH 'keepalive'").get())

    deleteKbFts(db, 'skill', 'reboot-server')
    assert.equal(db.prepare("SELECT name FROM kb_fts WHERE name = 'reboot-server'").get(), undefined)
  } finally { db.close() }
})

test('kb_fts_trigram catches substring matches', () => {
  const db = openDb(tmp())
  try {
    upsertKbFts(db, 'skill', 'disk-cleanup', 'reclaim space on /var, /tmp, journald')
    // trigram tokenizer matches substrings within tokens
    const hit = db.prepare("SELECT name FROM kb_fts_trigram WHERE kb_fts_trigram MATCH 'urnal'").get()
    assert.equal(hit?.name, 'disk-cleanup')
  } finally { db.close() }
})

test('clearKbFts wipes both index families', () => {
  const db = openDb(tmp())
  try {
    upsertKbFts(db, 'skill', 'a', 'alpha')
    upsertKbFts(db, 'skill', 'b', 'beta')
    clearKbFts(db)
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM kb_fts").get().c, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM kb_fts_trigram").get().c, 0)
  } finally { db.close() }
})
