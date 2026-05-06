# Design: Terminal Command Runner

## Approach

`runCommand({command, cwd, timeoutMs}, deps)` spawns `/bin/bash -c <command>` with the requested cwd. Captures stdout + stderr into rolling buffers capped at 1 MB each. On capture overflow, the buffer keeps the last MB and prepends a `... [truncated, original size N bytes]` marker.

Timeout is enforced by `setTimeout` wrapping a `child.kill('SIGTERM')`, with a follow-up `child.kill('SIGKILL')` 1 second later if the process is still alive.

The runner returns a typed result; the route handler is a thin wrapper that:
1. Validates input.
2. Inserts a `started`-status audit row.
3. Awaits `runCommand`.
4. Updates the audit row with terminal status + outputs.
5. Returns the result to the client.

We split concerns deliberately:
- `terminal-runner.ts` — pure compute (spawn + buffer + timeout). Testable with a stub spawn.
- `terminal-store.ts` — SQLite read/write. Testable with `openDb` against tmp file.
- `terminal.ts` route — HTTP glue.

## Architecture

```
POST /api/terminal/exec
  ↓
src/routes/terminal.ts::handleTerminalExec
  ↓
  ├─→ TerminalStore.start(id, command, cwd) → INSERT row, status='running'
  │
  ├─→ runCommand(...) — child_process.spawn('/bin/bash', ['-c', command], { cwd })
  │      ↓ (resolves on exit, timeout, or error)
  │
  └─→ TerminalStore.complete(id, {exitCode, stdout, stderr, status, durationMs})
       ↓
       UPDATE row, terminal status

GET /api/terminal/executions     → TerminalStore.list({limit, before})
GET /api/terminal/executions/:id → TerminalStore.get(id)
```

## Data model — migration 002

```sql
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
```

## Decisions

- **Decision:** One-shot runner now, interactive PTY later.
  **Why:** User answered. PTY is real complexity; runner gets us 80% of operator use today.

- **Decision:** `/bin/bash -c <command>` rather than `spawn(command, args)`.
  **Why:** Operators type pipelines, redirects, globs, env vars. Without a shell, none of that works. The cost is shell-injection risk — but we already trust the cookie-authenticated operator.

- **Decision:** Output capped at 1 MB per stream with a truncation marker.
  **Why:** Unbounded output trivially OOMs the server (`yes | head -c 10G > /tmp/x; cat /tmp/x`). 1 MB is enough for the 99th percentile audit (curl outputs, log tails); bigger output should land on disk via the user's command, not in our DB.

- **Decision:** Audit row inserted *before* spawn (`status='running'`), updated after.
  **Why:** If the server crashes mid-execution, the audit row still exists with `status='running'`, telling the next operator "this command was attempted, we don't know the outcome." Better than no row.

- **Decision:** Explicit `spawnBash` injection on `Wiring` for testability.
  **Why:** Same pattern as `spawnPi`. Tests stub it; production uses `child_process.spawn`.

- **Decision:** No SSE streaming for v1.
  **Why:** Adds a state machine (open stream, stream chunks, close on exit, cancel). Useful only when commands take >5s. We measure first; if operators complain, SSE lands in a follow-up.

## Risks & mitigations

- **Runaway command (`yes`, `dd if=/dev/zero`).** → 1 MB output cap + 60s default timeout. Operator sees a truncation marker and a status of `timeout`.
- **Operator runs `rm -rf /`.** → Trust by design. Audit log captures who, what, when. Out-of-band recovery (snapshots, etc.) is the answer; we don't try to be a sandbox.
- **Operator runs interactive command (`vim`, `htop`).** → Hangs on stdin reading until timeout. The error message in `stderr` typically explains; we surface the timeout status. Not great UX but not worse than running interactive commands in any non-PTY context.
- **Concurrent executions overload the box.** → No queueing today. If multiple parallel calls become an issue, we add a small in-memory semaphore (default 4 concurrent) in a follow-up.
- **`bash` not on PATH (some Linux containers).** → We hardcode `/bin/bash`. If the workspace runs somewhere this isn't true, we expose `PI_WORKSPACE_BASH_PATH` env override. Document in README.
