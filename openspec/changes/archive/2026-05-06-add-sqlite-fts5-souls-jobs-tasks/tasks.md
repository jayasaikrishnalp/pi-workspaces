# Tasks: SQLite + FTS5 + Souls + Jobs + Tasks

## 1. SQLite foundation

- [ ] 1.1 `npm install better-sqlite3` and pin in `package.json`. Verify install via `npm ls`.
- [ ] 1.2 `src/server/db.ts` — `openDb(path)`, sets WAL + synchronous=NORMAL + foreign_keys=ON. Wraps the SDK Database with a small typed surface (`exec`, `prepare`, `close`, `transaction`, `inTransaction`).
- [ ] 1.3 `src/server/db-migrations/001_init.sql` — schema_version, jobs, tasks, chat_messages, kb_fts (+ trigram), chat_fts (+ trigram), the three triggers.
- [ ] 1.4 `src/server/db-migrations/runner.ts` — discovers `NNN_*.sql` files, applies in order, advances schema_version inside `BEGIN IMMEDIATE`. Idempotent.
- [ ] 1.5 Wire `db: Database` onto `Wiring`. `getWiring()` opens DB; `server.on('close')` closes it (next to `mcpBroker.shutdownAll`).
- [ ] 1.6 `tests/db.test.mjs` — fresh-boot creates schema; subsequent boot is a no-op; pragmas verified; trigger keeps chat_fts in sync.

## 2. FTS5 search

- [ ] 2.1 `src/server/search.ts` — `sanitizeFtsQuery(raw)` (strip unmatched `"`, escape `(:)*^` outside quotes), `searchKb(db, q, kinds, limit)`, `searchChat(db, q, limit)`, `searchAll(db, q, kinds, limit)`. Union + dedupe + sort by score.
- [ ] 2.2 `src/server/db.ts` adds `upsertKbFts(kind, name, body)`, `deleteKbFts(kind, name)`, `rebuildKbFtsFromDisk(kbRoot)`.
- [ ] 2.3 Hook the kb-watcher: on `add`/`change`, parse the file and `upsertKbFts`; on `unlink`, `deleteKbFts`. Skip souls subdir? No — souls indexed too.
- [ ] 2.4 On boot, run `rebuildKbFtsFromDisk(kbRoot)` once after migrations to recover from any drift.
- [ ] 2.5 `src/routes/search.ts` — `handleSearch` per spec; register in `src/server.ts`.
- [ ] 2.6 `tests/search.test.mjs` — sanitizer table-driven, kb-fts round-trip (write SKILL.md → search returns it), trigram substring, chat-fts trigger, dedupe.

## 3. Souls domain

- [ ] 3.1 `src/server/soul-writer.ts` — wraps `kb-writer.writeKbFile` for souls. Same shape as agent-writer / workflow-writer.
- [ ] 3.2 `src/types/kb.ts` — extend `KbNodeKind` with `'soul'`; extend `SkillEdge.kind` with `'embodies'`.
- [ ] 3.3 `src/server/kb-writer.ts` — add `'souls'` to `FILENAME_BY_KIND` (`SOUL.md`).
- [ ] 3.4 `src/server/kb-browser.ts` — walk `<kbRoot>/souls/<name>/SOUL.md`; emit nodes; emit `embodies` edges from each agent's `soul:` ref.
- [ ] 3.5 `src/routes/souls.ts` — list, create, read, update. Mirror agents.ts.
- [ ] 3.6 Register routes in `src/server.ts`.
- [ ] 3.7 `tests/souls-route.test.mjs` — full CRUD parity with agents tests; embodies-edge regression in kb-browser test.

## 4. Agents `soul:` field

- [ ] 4.1 `src/server/agent-writer.ts` — accept optional `soul` field; validate against `KnownEntities.souls: Set<string>`; throw `UNKNOWN_SOUL` on miss.
- [ ] 4.2 Update `tests/agents-workflows-memory-route.test.mjs` — add a soul fixture, assert agent POST with valid soul succeeds, agent POST with bad soul → 400 UNKNOWN_SOUL.

## 5. Jobs domain

- [ ] 5.1 `src/server/jobs-store.ts` — `createJob(...)`, `transition(id, from, to)` inside `BEGIN IMMEDIATE`, `cancel(id)`, `list({status?, limit?})`, `get(id)`. Wraps `Wiring.db` only.
- [ ] 5.2 `src/server/pi-rpc-bridge.ts` — on `send`, create a job (`queued`), pass run-id to it; on bridge `running` event, transition `queued→running`; on completion, `running→completed | failed`; on abort ack, `running→cancelled`.
- [ ] 5.3 `src/routes/jobs.ts` — list, get, cancel.
- [ ] 5.4 Register in `src/server.ts`.
- [ ] 5.5 `tests/jobs-store.test.mjs` — state-machine table-driven; CAS contention.
- [ ] 5.6 `tests/jobs-route.test.mjs` — list/get/cancel; 409 on bad transition; integration with a stub bridge.

## 6. Tasks domain

- [ ] 6.1 `src/server/tasks-store.ts` — `create(input)` with idempotency-key dedup, `update(id, patch)` with state-machine guard, `list(filters)`, `get(id)`, `archive(id)`.
- [ ] 6.2 `src/routes/tasks.ts` — five handlers per spec.
- [ ] 6.3 Register in `src/server.ts`.
- [ ] 6.4 `tests/tasks-store.test.mjs` — state machine: legal/illegal transition matrix; idempotency dedup; priority sort.
- [ ] 6.5 `tests/tasks-route.test.mjs` — CRUD + filter combinations.

## 7. Probe + hand-test

- [ ] 7.1 `src/routes/probe.ts` — append `db:{ok, schemaVersion}`, `jobs:{count}`, `tasks:{count, byStatus}`.
- [ ] 7.2 Boot the workspace, hit `/api/probe`, verify shape.
- [ ] 7.3 POST a soul, POST an agent referencing it, query `/api/kb/graph`, assert embodies edge.
- [ ] 7.4 POST a chat send, observe job row appears with terminal status.

## 8. Review + verification

- [ ] 8.1 Every requirement scenario across the five delta specs backed by at least one test.
- [ ] 8.2 Full local suite green.
- [ ] 8.3 Codex review — deferred to follow-up (paired with the next codex sweep).
- [ ] 8.4 Three commits + push (propose / implement / archive).
