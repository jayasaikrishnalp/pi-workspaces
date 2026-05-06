# Search-index Spec

## Purpose

SQLite + FTS5 foundation. The single workspace database at <workspaceRoot>/data.sqlite hosts jobs, tasks, chat_messages, and the kb_fts/chat_fts virtual tables. WAL mode + foreign_keys + busy_timeout. Hand-rolled additive migrations. Global GET /api/search endpoint unions kb (markdown bodies) + chat (run-store messages), dedupes across unicode61 and trigram tokenizers.

## Requirements



### Requirement: SQLite Workspace Database

The system SHALL maintain a single SQLite database file at `<workspaceRoot>/data.sqlite`. On every connection, the system MUST set `journal_mode=WAL`, `synchronous=NORMAL`, and `foreign_keys=ON`. The DB connection lives on `Wiring.db` and is closed when the HTTP server emits `close`.

#### Scenario: First boot creates and migrates the database

- **GIVEN** the workspace was never started before, no `data.sqlite` exists
- **WHEN** the workspace boots
- **THEN** `data.sqlite` is created in `<workspaceRoot>/`
- **AND** `schema_version` table contains the current version number
- **AND** all tables (`jobs`, `tasks`, `chat_messages`, `kb_fts`, `kb_fts_trigram`, `chat_fts`, `chat_fts_trigram`) exist

#### Scenario: Subsequent boots run pending migrations only

- **GIVEN** `data.sqlite` exists with `schema_version=1` and the workspace has migrations 1 and 2 defined
- **WHEN** the workspace boots
- **THEN** migration 2's SQL is applied and `schema_version` advances to 2
- **AND** migration 1 is NOT re-run

### Requirement: Global Search Endpoint

The system SHALL expose `GET /api/search?q=<text>&kind=<csv>&limit=<n>` returning results ranked by FTS5 relevance across the kb_fts and chat_fts indexes. The `kind` filter accepts a comma-separated subset of `skill,agent,workflow,memory,soul,chat` (default: all). `limit` clamps to `[1,200]` (default: 20). The response shape is `{results: [{kind, name?, runId?, messageId?, snippet, score, path?}]}`.

The system MUST sanitize the `q` parameter before MATCH evaluation: strip unmatched double-quotes, escape FTS5 special characters (`(`, `)`, `*`, `:`, `^`) outside quoted phrases, and reject empty queries with `400 INVALID_QUERY`.

The system MUST union results from the unicode61 and trigram indexes, deduplicate by `(kind, rowid)` keeping the higher score, and sort by score descending.

#### Scenario: Search across skills returns matching nodes

- **GIVEN** a skill `aws-cleanup` with body containing the word "snapshot"
- **WHEN** an authenticated client sends `GET /api/search?q=snapshot&kind=skill`
- **THEN** the response status is `200`
- **AND** `results` contains an entry with `{kind:"skill", name:"aws-cleanup"}` and a non-empty `snippet`

#### Scenario: Substring match works via trigram tokenizer

- **GIVEN** a skill `disk-cleanup` with body containing the word "journald"
- **WHEN** a client searches for `q=urnal` (a substring, not a full token)
- **THEN** the response includes a result for `disk-cleanup`

#### Scenario: Empty query rejected

- **WHEN** a client sends `GET /api/search?q=`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"INVALID_QUERY", ...}}`

#### Scenario: Specials in query are stripped, not crash

- **WHEN** a client sends `GET /api/search?q=foo(bar)*` (unbalanced FTS5 specials)
- **THEN** the response status is `200`
- **AND** the request is treated as if the user searched for `foo bar` (quoted, escaped)

### Requirement: KB Index Stays Consistent With Disk

The system's kb-watcher MUST upsert into `kb_fts` and `kb_fts_trigram` on every `add` and `change` event under `<kbRoot>/{skills,agents,workflows,memory,souls}/`, and DELETE from both on `unlink`. On workspace boot, the system MUST rebuild the kb_fts indexes from disk to recover from any inconsistency caused by crashes mid-write.

#### Scenario: New SKILL.md becomes searchable within 1 second of write

- **GIVEN** a client connected to `GET /api/kb/events` and the kb_fts index is up to date
- **WHEN** a SKILL.md file is written atomically to `<kbRoot>/skills/new-skill/SKILL.md` with body containing the word `xylophone`
- **THEN** within 1500ms a `GET /api/search?q=xylophone&kind=skill` returns a result for `new-skill`

#### Scenario: Deleted skill is removed from the index

- **GIVEN** a skill `going-away` is in the kb_fts index
- **WHEN** the file is deleted
- **THEN** within 1500ms `GET /api/search?q=<term-from-going-away>` does NOT return `going-away`

### Requirement: Chat FTS Triggers

The system SHALL maintain `chat_fts` and `chat_fts_trigram` synchronously with the `chat_messages` table via SQLite triggers. Inserts, updates, and deletes on `chat_messages` MUST keep both FTS5 indexes consistent within the same transaction.

#### Scenario: Inserting a chat message makes it searchable in the same transaction

- **GIVEN** the database is open
- **WHEN** a client (test harness) inserts a row into `chat_messages` with `content="quick brown fox"`
- **THEN** an immediate `SELECT rowid FROM chat_fts WHERE chat_fts MATCH 'fox'` returns the new rowid
- **AND** the trigram variant returns the same rowid for `MATCH 'rown'` (substring)
