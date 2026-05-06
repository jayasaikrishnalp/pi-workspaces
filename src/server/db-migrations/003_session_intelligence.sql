-- Migration 003: session intelligence — token + cost columns + indexes.
-- Additive only. Existing rows (user/system/tool messages) get NOT NULL
-- DEFAULT 0 for the token columns and remain valid.

ALTER TABLE chat_messages ADD COLUMN tokens_in   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN tokens_out  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN cache_read  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN cost_usd    REAL    NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN model       TEXT;
ALTER TABLE chat_messages ADD COLUMN provider    TEXT;
ALTER TABLE chat_messages ADD COLUMN api         TEXT;
ALTER TABLE chat_messages ADD COLUMN response_id TEXT;
ALTER TABLE chat_messages ADD COLUMN duration_ms INTEGER;

-- Aggregation indexes — required for the dashboard endpoint to stay fast.
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created         ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_model           ON chat_messages(model)     WHERE model     IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_messages_tool            ON chat_messages(tool_name) WHERE tool_name IS NOT NULL;

-- Session titles — separate table so a future LLM-titler can backfill
-- without touching message rows.
CREATE TABLE IF NOT EXISTS session_titles (
  session_id TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  set_at     INTEGER NOT NULL
);
