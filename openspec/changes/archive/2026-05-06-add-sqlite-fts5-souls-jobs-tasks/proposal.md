# Proposal: SQLite + FTS5 Foundation, Souls, Jobs, Tasks

## Why

The v2 frontend design adds Souls (agent identity), Jobs (persistent units of agent work), Tasks (operator + agent todos), Sessions Intelligence, and global ⌘K search. None of these have a backend yet. Markdown-on-disk works for skills/agents/workflows/memory because they're slow-changing, human-edited content; it does NOT work for high-write data (jobs created on every chat send, tasks moved between states, chat message corpora used for search).

We need a structured datastore. Hermes (`~/research-folder/ai-projects/hermes-agent`) is the closest reference architecture in our orbit and has battle-tested patterns we should adopt: WAL-mode SQLite with hand-rolled additive migrations, FTS5 dual-tokenizer for substring + CJK, CAS via `claim_lock` for safe concurrency, three-layer (task → run → event) auditability. We adopt those patterns; we deviate from Hermes where its choices don't fit our scope (HERMES_HOME-per-profile isolation, JSON-file job storage, "job" = cron-only).

## What changes

- **SQLite foundation** (`better-sqlite3`) at `~/.pi-workspace/data.sqlite` with WAL + `synchronous=NORMAL` + `foreign_keys=ON`. Hand-rolled additive migrations via `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`. Versioned with a `schema_version` table.
- **FTS5 search index** with dual tokenizer (unicode61 + trigram). Two index families:
  - `kb_fts` over skill / agent / workflow / memory / soul bodies — populated by the existing `kb-watcher` on every `add` / `change` / `unlink`.
  - `chat_fts` over chat message text + tool names — populated by SQLite triggers on the `chat_messages` table.
- **`GET /api/search?q=&kind=&limit=`** — global search endpoint. Query sanitizer strips/quotes unmatched FTS5 specials. Returns `{kind, name?, runId?, messageId?, snippet, score, path?}`.
- **Souls domain** — agent character/identity:
  - File-based at `<kbRoot>/souls/<name>/SOUL.md` (mirrors skills/agents/workflows/memory layout). Frontmatter: `name`, `description`, `values[]`, `priorities[]`, `risk_tolerance`, `decision_principles[]`, `tone`, `model_preference?`. Body: free-form narrative ("who this character is").
  - REST: `GET /api/souls`, `POST /api/souls`, `GET /api/souls/:name`, `PUT /api/souls/:name`. Exact same shape as `/api/agents`.
  - Souls become graph nodes (`source: "soul"`) with `embodies` edges from agent → soul.
- **Agents extended** — optional `soul:` frontmatter field on agents, validated against known souls. Multiple agents can reference the same soul (e.g., several oncall agents share a `stoic-operator` soul).
- **Jobs domain** — persistent units of agent work, SQLite-backed:
  - Schema: `id, soul_id?, agent_id?, run_id?, status (queued|running|completed|failed|cancelled), title, source (operator|agent|cron), created_at, started_at?, completed_at?, summary?, error?, claim_lock?, claim_expires`.
  - Every chat `POST /api/sessions/:k/send-stream` creates a `queued` Job, transitions to `running` when the bridge accepts it, settles to `completed` / `failed` / `cancelled` based on the run-store state. Existing `runs/` JSONL files keep their role; Jobs is a thin index over them.
  - REST: `GET /api/jobs`, `GET /api/jobs/:id`, `POST /api/jobs/:id/cancel`. (No `POST /api/jobs` for v1 — Jobs are derived from chat sends, not directly created by the operator.)
- **Tasks domain** — operator-and-agent todos, SQLite-backed:
  - Schema: `id, title, body?, status (triage|todo|ready|running|blocked|done|archived), priority, source (operator|agent), assignee_soul_id?, parent_task_id?, linked_job_id?, created_by, created_at, started_at?, completed_at?, claim_lock?, claim_expires, result?`.
  - REST: `GET /api/tasks`, `POST /api/tasks` (operator), `PUT /api/tasks/:id` (status transitions, owner change), `DELETE /api/tasks/:id`. Agent-source tasks land via the same POST with `source:"agent"` set by future tooling — no separate endpoint.
  - Status transitions guarded: `triage → (todo|ready|archived)`, `todo → (ready|archived|blocked)`, `ready → (running|blocked|archived)`, `running → (done|blocked|failed|archived)`, terminal: `done | archived`.
- **`/api/probe` extended** — adds `db: { ok, schemaVersion }`, `jobs: { count }`, `tasks: { count, byStatus }`.

## Scope

**In scope**
- SQLite foundation, all four migrations, FTS5 index families, search endpoint and sanitizer.
- Souls domain (writer + routes + graph integration).
- Agents `soul:` field validation.
- Jobs auto-creation hooked into the existing chat-send path.
- Tasks full CRUD with state-machine validation.
- Probe surfacing the new fields.
- Tests: writer-level unit tests, FTS5 round-trip tests, route-level tests, state-machine tests, ~60 new tests.

**Out of scope**
- Cron / scheduled jobs — separate follow-up domain (`add-schedules`).
- Multi-tenant fields (`tenant_id` etc.) — single-machine workspace.
- Task DAG via `task_links` table — Hermes has it; we defer until two operators ask for it.
- Profile-level isolation à la HERMES_HOME-per-profile — souls are referenceable identity, not process isolation.
- `task_events` audit log table — defer.
- Chat-message persistence to SQLite from the existing `runs/` JSONL files — Jobs reference run IDs; messages stay where they are. Chat FTS5 indexes the run-store messages on the fly when ingested by a thin migration job (Phase 2 if needed).

## Impact

- Affected specs: `search-index` (new), `souls` (new), `jobs` (new), `tasks` (new), `agents` (modified — `soul:` field), `probe` (modified — new fields).
- Affected code: `package.json` (+ `better-sqlite3`), `src/server/db.ts` (new — connection + migrations + pragmas), `src/server/db-migrations/{001..}.sql` (new), `src/server/search.ts` (new — FTS5 query + sanitizer), `src/server/soul-writer.ts` (new), `src/server/jobs-store.ts` (new), `src/server/tasks-store.ts` (new), `src/routes/{search,souls,jobs,tasks}.ts` (new), `src/server.ts` (route table + db wiring + shutdown), `src/server/wiring.ts` (db handle on Wiring), `src/server/agent-writer.ts` (validate `soul:` field), `src/server/kb-browser.ts` (souls graph nodes + embodies edges), `src/server/kb-watcher.ts` (FTS5 reindex on kb events), `src/server/pi-rpc-bridge.ts` (job state transitions on send-stream / completion / abort), `src/routes/probe.ts` (new fields).
- New tests: `tests/db.test.mjs`, `tests/search.test.mjs`, `tests/souls-route.test.mjs`, `tests/jobs-store.test.mjs`, `tests/jobs-route.test.mjs`, `tests/tasks-store.test.mjs`, `tests/tasks-route.test.mjs`.
- Risk: medium-high. SQLite is new infrastructure; concurrency bugs hide until production load. Mitigation: WAL + CAS pattern from Hermes is well-understood; all writes go through small store classes with explicit `BEGIN IMMEDIATE`; CI runs every state-machine transition.
- Migration: existing workspaces have no DB file; first boot creates and migrates. No data migration.
