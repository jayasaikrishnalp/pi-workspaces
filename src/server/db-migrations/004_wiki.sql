-- Migration 004: WK pipeline wiki ingest store + FTS5.
-- Source corpus: /Users/.../pipeline-information/wiki/ (overridable via WIKI_ROOT).
-- One row per markdown file. FTS5 contentless table mirrors title+body for BM25 search.

CREATE TABLE IF NOT EXISTS wiki_docs (
  path        TEXT PRIMARY KEY,        -- relative-to-wiki-root, forward slashes
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  frontmatter TEXT,                    -- raw YAML block, may be empty
  updated_at  INTEGER NOT NULL,        -- mtime in ms
  ingested_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wiki_docs_updated ON wiki_docs(updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  path UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
