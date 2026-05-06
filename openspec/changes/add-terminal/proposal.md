# Proposal: Terminal — Command Runner With Full Audit

## Why

The v2 frontend has a Terminal screen. The operator needs to run ad-hoc shell commands from the workspace UI without leaving for iTerm. We start with a one-shot **command runner** (single bash command, capture stdout/stderr/exit, return) rather than a full interactive PTY because PTY introduces real platform/security complexity (escape sequences, signal handling, abandoned children); a runner covers ~80% of operator use without that cost.

Every execution is **audit-logged to SQLite** so a later operator can see what was run and by whom, even months later.

## What changes

- **`POST /api/terminal/exec`** — accepts `{command, cwd?, timeoutMs?}`, spawns `/bin/bash -c <command>` with the requested cwd (defaults to `workspaceRoot`), captures stdout + stderr (truncated at 1 MB each), returns `{id, status, exitCode, stdout, stderr, durationMs}`. Default timeout 60s, max 300s. Rejects commands longer than 4096 chars with `400 COMMAND_TOO_LONG`. Cookie-gated.
- **Audit table** `terminal_executions` (migration `002`) with `id, command, cwd, exit_code?, stdout, stderr, status, started_at, ended_at?, duration_ms?, created_by?`. Status enum: `completed | timeout | killed | error`.
- **`GET /api/terminal/executions?limit=&before=`** — paginated audit log.
- **`GET /api/terminal/executions/:id`** — full row.
- **No DELETE** — audit log is append-only.

## Scope

**In scope**
- Single command-per-request runner.
- Audit log + list endpoints.
- 1 MB per-stream output cap with explicit truncation marker.
- 60s default / 300s max timeout via `AbortSignal.timeout`.
- Hard-kill: `SIGTERM` then `SIGKILL` after 1s grace.

**Out of scope**
- Interactive PTY (xterm.js + node-pty) — separate follow-up if operators need vim/htop in-browser.
- Streaming stdout to the client during execution (SSE) — first-pass returns the whole output at once. Streaming lands when the chat panel needs the same surface.
- Signal forwarding (Ctrl-C from browser) — n/a without an interactive PTY.
- Per-soul shell environment overlays — defer.
- Command sandboxing / allowlist — the operator authenticated via cookie; we trust them. Audit catches the rest.

## Impact

- Affected specs: `terminal` (new).
- Affected code: `src/server/db-migrations/002_terminal.sql` (new), `src/server/terminal-runner.ts` (new), `src/server/terminal-store.ts` (new), `src/routes/terminal.ts` (new), `src/server.ts` (routes + spawn injection — `spawnBash` parameter on `Wiring` for testability).
- Tests: stub-spawn unit tests of the runner (timeout, exit codes, output truncation, kill semantics), HTTP route tests, audit-row shape.
- Risk: medium-high. Shell access = full machine control. Mitigations: (1) cookie auth required; (2) every execution audited; (3) bounded resources (timeout, output size, command length); (4) explicit kill of orphaned children.
