# Tasks: Terminal Command Runner

## 1. Schema + store

- [ ] 1.1 `src/server/db-migrations/002_terminal.sql` — `terminal_executions` table + `idx_terminal_executions_started`.
- [ ] 1.2 `src/server/terminal-store.ts` — `start(id, command, cwd, createdBy?)`, `complete(id, {status, exitCode?, stdout, stderr, durationMs})`, `get(id)`, `list({limit, before})`. All inside `BEGIN IMMEDIATE` for the writes.

## 2. Runner

- [ ] 2.1 `src/server/terminal-runner.ts` — `runCommand({command, cwd, timeoutMs}, deps): Promise<{status, exitCode?, stdout, stderr, durationMs}>`. Buffers stdout/stderr with 1MB cap + truncation marker. SIGTERM-then-SIGKILL.
- [ ] 2.2 `src/server/wiring.ts` — `spawnBash: SpawnLike` field with default `(args, opts) => spawn('/bin/bash', args, opts)`.
- [ ] 2.3 `tests/terminal-runner.test.mjs` — happy path, non-zero exit, timeout, output overflow truncation, spawn ENOENT error.

## 3. Routes

- [ ] 3.1 `src/routes/terminal.ts` — three handlers: exec, list, read. Validation per spec.
- [ ] 3.2 Register in `src/server.ts`.
- [ ] 3.3 `tests/terminal-route.test.mjs` — POST exec happy path, COMMAND_TOO_LONG, list paging, GET 404, audit row exists after exec.

## 4. Probe + verification

- [ ] 4.1 `src/routes/probe.ts` — append `terminal: { count }`.
- [ ] 4.2 Boot the workspace, run a hand-test: `curl -X POST /api/terminal/exec -d '{"command":"date"}'`, verify response shape; `GET /api/terminal/executions` returns the row.

## 5. Review + verification

- [ ] 5.1 Every requirement scenario in `specs/terminal/spec.md` backed by at least one test.
- [ ] 5.2 Full local suite green.
- [ ] 5.3 Codex review — deferred.
- [ ] 5.4 Three commits + push (propose / implement / archive).
