-- Migration 001: initial schema for cloudops-workspace SQLite.
-- See openspec/specs/{search-index,jobs,tasks}/spec.md for the source of truth.

-- Jobs: persistent units of agent work (one per chat send).
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  soul_id       TEXT,
  agent_id      TEXT,
  run_id        TEXT,
  session_id    TEXT,
  status        TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  title         TEXT,
  source        TEXT NOT NULL CHECK(source IN ('operator','agent','cron')),
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER,
  summary       TEXT,
  error         TEXT,
  claim_lock    TEXT,
  claim_expires INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON jobs(run_id);

-- Tasks: operator + agent todos (Hermes-kanban-shape).
CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  body              TEXT,
  status            TEXT NOT NULL CHECK(status IN ('triage','todo','ready','running','blocked','done','archived')),
  priority          INTEGER NOT NULL DEFAULT 0,
  source            TEXT NOT NULL CHECK(source IN ('operator','agent')),
  assignee_soul_id  TEXT,
  parent_task_id    TEXT,
  linked_job_id     TEXT,
  created_by        TEXT,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  completed_at      INTEGER,
  claim_lock        TEXT,
  claim_expires     INTEGER NOT NULL DEFAULT 0,
  result            TEXT,
  idempotency_key   TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);

-- Chat messages mirror (lazy-populated for FTS5).
CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  session_id  TEXT,
  role        TEXT NOT NULL,
  content     TEXT,
  tool_name   TEXT,
  tool_calls  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_run ON chat_messages(run_id);

-- FTS5 indexes — kb (markdown bodies) + chat (chat_messages).
-- Dual tokenizer (unicode61 + trigram) per Hermes pattern: unicode61 ranks
-- normal queries best; trigram catches substring + CJK.

CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  kind, name, body,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts_trigram USING fts5(
  kind, name, body,
  tokenize = 'trigram'
);

-- Chat FTS uses content=chat_messages so it's automatically kept in sync
-- by the triggers below; rowid maps to chat_messages.rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
  content, tool_name,
  content='chat_messages', content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts_trigram USING fts5(
  content, tool_name,
  content='chat_messages', content_rowid='rowid',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
  INSERT INTO chat_fts(rowid, content, tool_name) VALUES (new.rowid, new.content, new.tool_name);
  INSERT INTO chat_fts_trigram(rowid, content, tool_name) VALUES (new.rowid, new.content, new.tool_name);
END;

CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE ON chat_messages BEGIN
  INSERT INTO chat_fts(chat_fts, rowid, content, tool_name) VALUES('delete', old.rowid, old.content, old.tool_name);
  INSERT INTO chat_fts(rowid, content, tool_name) VALUES (new.rowid, new.content, new.tool_name);
  INSERT INTO chat_fts_trigram(chat_fts_trigram, rowid, content, tool_name) VALUES('delete', old.rowid, old.content, old.tool_name);
  INSERT INTO chat_fts_trigram(rowid, content, tool_name) VALUES (new.rowid, new.content, new.tool_name);
END;

CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
  INSERT INTO chat_fts(chat_fts, rowid, content, tool_name) VALUES('delete', old.rowid, old.content, old.tool_name);
  INSERT INTO chat_fts_trigram(chat_fts_trigram, rowid, content, tool_name) VALUES('delete', old.rowid, old.content, old.tool_name);
END;
