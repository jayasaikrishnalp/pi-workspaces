# Design: SQLite + FTS5 + Souls + Jobs + Tasks

## Approach

Adopt Hermes's proven SQLite patterns; deviate where their choices don't fit our scope (single-process, single-machine, file-based knowledge base).

The library is `better-sqlite3` — synchronous, fast, perfect for a single-process workspace. Async wrappers add complexity we don't need; if we ever need async, the call sites are concentrated in 3–4 store classes that are easy to refactor.

The DB lives at `~/.pi-workspace/data.sqlite` next to runs/, sessions.json, etc. WAL mode + `synchronous=NORMAL` + `foreign_keys=ON` are set on every connection open. The DB connection is a singleton on `Wiring` (`Wiring.db: Database`). On shutdown, `db.close()` is called from the existing `server.on('close')` hook (next to `mcpBroker.shutdownAll()`).

Migrations are hand-rolled, additive only. A `schema_version` table tracks the highest applied version. The migration runner checks current version, then runs SQL files for each missing version in order. ALTER TABLE ADD COLUMN is the workhorse; we never DROP / RENAME / restructure (Hermes proved this is enough for years).

FTS5 has two index families:

- **`kb_fts`** indexes on-disk markdown bodies. Source of truth stays on disk under `<kbRoot>/{skills,agents,workflows,memory,souls}/`. The kb-watcher already emits `kb.changed` events; we hook into that to upsert into `kb_fts`. Initial reindex on boot reads the disk and rebuilds. This trades minor index drift on crash for a much simpler design than triggers (which would require moving content into SQLite).

- **`chat_fts`** indexes chat messages. For v1 the index is best-effort: when a run completes successfully, the message tail of its `runs/<id>.jsonl` file is read and inserted into `chat_messages` + `chat_fts`. SQLite triggers keep `chat_fts` in sync with `chat_messages`. We DON'T migrate every old run on boot — that's an O(N) scan. Instead, runs that fail to find an FTS hit are reindexed lazily.

Both indexes use the dual-tokenizer pattern from Hermes: a primary `unicode61` index for normal queries, a `_trigram` shadow for substring + CJK matching. The search endpoint queries both and unions results.

## Architecture

```
~/.pi-workspace/
├── data.sqlite               ← single file, WAL mode
│   ├── schema_version
│   ├── jobs                  ← unit of agent work
│   ├── tasks                 ← operator + agent todos
│   ├── chat_messages         ← FTS5-indexable mirror of runs/<id>.jsonl
│   ├── kb_fts                ← FTS5 virtual table (skills/agents/workflows/memory/souls bodies)
│   ├── kb_fts_trigram        ← FTS5 virtual table (trigram tokenizer)
│   ├── chat_fts              ← FTS5 virtual table over chat_messages
│   └── chat_fts_trigram      ← FTS5 virtual table (trigram tokenizer)
├── data.sqlite-wal           ← WAL file
├── data.sqlite-shm           ← shared memory file
├── runs/<id>.jsonl           ← unchanged, source of truth for chat messages
└── server.port               ← unchanged

<kbRoot>/
├── skills/<name>/SKILL.md    ← unchanged
├── agents/<name>/AGENT.md    ← extended: optional `soul:` frontmatter
├── workflows/<name>/WORKFLOW.md
├── memory/<name>.md
└── souls/<name>/SOUL.md      ← NEW
```

## Data model — SQLite tables

```sql
-- Migration tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Jobs: one per chat send (and later, one per scheduled run)
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  soul_id       TEXT,
  agent_id      TEXT,
  run_id        TEXT,                  -- references runs/<id>.jsonl
  session_id    TEXT,
  status        TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  title         TEXT,
  source        TEXT NOT NULL CHECK(source IN ('operator','agent','cron')),
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER,
  summary       TEXT,
  error         TEXT,
  claim_lock    TEXT,                  -- CAS lock for future multi-worker
  claim_expires INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_run_id ON jobs(run_id);

-- Tasks: operator-and-agent todos (Hermes kanban shape, slimmed)
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

-- Chat messages mirror (lazy-populated for FTS5)
CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  session_id  TEXT,
  role        TEXT NOT NULL,             -- 'user' | 'assistant' | 'system' | 'tool'
  content     TEXT,
  tool_name   TEXT,
  tool_calls  TEXT,                      -- JSON, opaque to FTS
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_run ON chat_messages(run_id);

-- FTS5 virtual tables (unicode61 + trigram dual tokenizer)
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  kind, name, body,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts_trigram USING fts5(
  kind, name, body,
  tokenize = 'trigram'
);
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

-- Triggers keep chat_fts in sync (kb_fts is upserted from the watcher; no triggers needed)
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
```

## Decisions

- **Decision:** `better-sqlite3` (synchronous), not `sqlite3` (async).
  **Why:** Single process. The synchronous API is simpler, faster, and avoids callback/promise interleaving for state-machine transitions. Hermes uses Python's blocking `sqlite3` — same shape.

- **Decision:** Hand-rolled additive migrations, no `knex`/`umzug`/`drizzle`.
  **Why:** Hermes's experience: additive migrations + `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` cover years of evolution. Migration libraries pull in churn we don't need.

- **Decision:** Markdown stays the source of truth for skills/agents/workflows/memory/souls; SQLite is a derived FTS5 index.
  **Why:** User answered this directly. Plays well with `git`-tracked kbRoot. External editors (vim, IDEs) work without DB knowledge. Watcher already emits the events we need.

- **Decision:** Dual-tokenizer FTS5 (unicode61 + trigram) from Hermes.
  **Why:** Trigram catches substring + CJK; unicode61 ranks normal queries better. Total cost is 2× index size — acceptable.

- **Decision:** Sanitize FTS5 user input rather than parameterize MATCH.
  **Why:** SQLite FTS5 MATCH is not parameterized in the SQL sense — query text is interpreted by the FTS engine. Hermes's sanitizer (`_sanitize_fts5_query`) strips/escapes specials; we port the same approach.

- **Decision:** "Job" = unit of agent work; cron schedules deferred to a separate change.
  **Why:** Hermes conflates the two; that's confusing. We separate: Jobs = work, Schedules = recurrence.

- **Decision:** Souls is a new file-based domain (mirrors agents/workflows/memory). Agents reference souls by name in optional `soul:` frontmatter.
  **Why:** Identity needs to be reusable across multiple agents and version-controllable in `git`. File-based fits the existing kbRoot model. Souls become graph nodes (`source: "soul"`) with `embodies` edges from referencing agents — visible in the knowledge graph.

- **Decision:** Tasks state machine guarded server-side, not just on the client.
  **Why:** Operators and agents both write through `PUT /api/tasks/:id`; if the server doesn't enforce transitions, the same task can land in inconsistent states. Hermes does this with their `_assert_status_transition` helper; we copy it.

- **Decision:** No `task_events` audit log in v1 (Hermes has one).
  **Why:** Three-layer (task → run → events) is over-engineered for our day-1. Status changes ARE the audit log; if we want events later, they're additive.

- **Decision:** Job auto-creation hooked into `pi-rpc-bridge.send`, not a separate POST endpoint.
  **Why:** Every chat send IS a job. A separate endpoint creates two ways to do the same thing. The bridge lifecycle (send → run-id → completion / abort) maps 1:1 to the Job state machine.

- **Decision:** No `tenant_id` field anywhere.
  **Why:** Single-machine workspace. Adding a column we don't use is busywork; if multi-tenant lands, an `ALTER TABLE ADD COLUMN tenant_id TEXT` is one migration step away.

## Affected files

- New: `src/server/db.ts`, `src/server/db-migrations/001_init.sql` (everything above), `src/server/search.ts`, `src/server/soul-writer.ts`, `src/server/jobs-store.ts`, `src/server/tasks-store.ts`, `src/routes/{search,souls,jobs,tasks}.ts`.
- Modified: `src/server.ts` (route table, db wiring, shutdown order), `src/server/wiring.ts` (`db: Database` field), `src/server/agent-writer.ts` (validate optional `soul:`), `src/server/kb-browser.ts` (walk souls subdir, emit `embodies` edges), `src/server/kb-watcher.ts` (call into `db.upsertKbFts` on each event), `src/server/pi-rpc-bridge.ts` (Job state transitions), `src/routes/probe.ts` (new fields), `src/types/kb.ts` (KbNodeKind union + 'soul', SkillEdge.kind + 'embodies').
- New tests as enumerated in the proposal.

## Risks & mitigations

- **`better-sqlite3` is a native module** — needs a binary per Node version. → Use `--build-from-source` fallback in install; document in README. CI on Node 22 (matches our `engines.node`).
- **WAL files left after crash.** → Documented; harmless on next boot, SQLite recovers from WAL on connection open.
- **FTS5 index drift on crash mid-write.** → Worst case the operator gets stale results until the next watcher event; full reindex is `npm run db:reindex` (one-shot script).
- **Migration runner runs twice in tests.** → `_resetWiringForTests` closes the db handle; tests use isolated tmp dirs so no shared state.
- **Triggers fire during bulk inserts and slow them.** → Acceptable for our message volumes; if it ever matters, batch-insert with `INSERT OR IGNORE INTO chat_fts(chat_fts) VALUES('rebuild')`.
- **Concurrency: two API calls update the same task simultaneously.** → CAS via `claim_lock` for `running` states; for state transitions, optimistic check inside `BEGIN IMMEDIATE` — Hermes pattern.
