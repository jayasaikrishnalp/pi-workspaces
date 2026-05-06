-- Migration 002: terminal_executions audit log.
-- See openspec/specs/terminal/spec.md.

CREATE TABLE IF NOT EXISTS terminal_executions (
  id           TEXT PRIMARY KEY,
  command      TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  exit_code    INTEGER,
  stdout       TEXT,
  stderr       TEXT,
  status       TEXT NOT NULL CHECK(status IN ('running','completed','timeout','killed','error')),
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  duration_ms  INTEGER,
  created_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_terminal_executions_started ON terminal_executions(started_at DESC);
