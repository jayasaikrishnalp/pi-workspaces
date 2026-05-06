# Terminal Spec

## Purpose

One-shot bash command runner exposed at POST /api/terminal/exec, with full append-only audit log to the terminal_executions SQLite table. Cookie-gated. Bounded resources: 1 MB per stream, 60s default / 300s max timeout, SIGTERM-then-SIGKILL kill flow, 4096-char command length. The frontend Terminal screen reads /api/terminal/executions for history. Interactive PTY is a deferred follow-up.

## Requirements



### Requirement: Command Execution Endpoint

The system SHALL expose `POST /api/terminal/exec` accepting JSON `{command: string, cwd?: string, timeoutMs?: number}`. The handler MUST:

- Reject when `command` is missing or not a non-empty string with `400 BAD_REQUEST`.
- Reject when `command.length > 4096` with `400 COMMAND_TOO_LONG`.
- Reject when `timeoutMs` exceeds 300000 with `400 TIMEOUT_TOO_LONG`.
- Default `cwd` to `workspaceRoot` when omitted.
- Default `timeoutMs` to 60000 when omitted.
- Spawn `/bin/bash -c <command>` with the resolved cwd.
- Capture stdout and stderr separately, each capped at 1_048_576 bytes. On overflow, retain the last 1 MB and prepend a marker `... [truncated, original size N bytes]`.
- Enforce timeout via `SIGTERM` after `timeoutMs`, then `SIGKILL` after a 1 second grace.
- Return `200 {id, status, exitCode, stdout, stderr, durationMs}` on completion.

#### Scenario: Successful command returns its output and exit 0

- **GIVEN** an authenticated operator
- **WHEN** they `POST /api/terminal/exec {command: "echo hello"}`
- **THEN** the response status is `200`
- **AND** the body has `status: "completed"`, `exitCode: 0`, and `stdout` containing `"hello"`

#### Scenario: Command that exits non-zero is captured but not an error response

- **WHEN** the operator runs `false`
- **THEN** the response status is `200`
- **AND** the body has `status: "completed"`, `exitCode: 1`, and empty stdout/stderr

#### Scenario: Long-running command is killed at timeout

- **GIVEN** a stub spawn that simulates a process hanging for 5 seconds
- **WHEN** the operator runs `POST /api/terminal/exec {command: "...", timeoutMs: 100}`
- **THEN** within ~1.5 seconds the response is `200`
- **AND** the body has `status: "timeout"` with `exitCode: null`

#### Scenario: Output overflow is truncated with a marker

- **GIVEN** a stub spawn that writes 5 MB to stdout
- **WHEN** the operator runs the command
- **THEN** the body's `stdout` length is approximately 1 MB
- **AND** `stdout` starts with `"... [truncated, original size"`

#### Scenario: Command longer than 4096 chars rejected

- **WHEN** the operator runs a command with 4097 characters
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"COMMAND_TOO_LONG"}}`

### Requirement: Audit Log Persistence

Every execution attempt SHALL produce one row in the `terminal_executions` SQLite table. The row MUST be created with `status='running'` *before* the spawn so that server crashes mid-execution leave evidence the command was attempted.

The row's terminal status MUST be one of `completed | timeout | killed | error`. `completed` covers any exit (zero or non-zero). `timeout` covers SIGTERM-after-timeout. `killed` covers operator-initiated termination (future feature; status reserved). `error` covers spawn failures (e.g. ENOENT for /bin/bash).

#### Scenario: Audit row exists immediately after exec endpoint returns

- **GIVEN** the operator just ran `echo hi`
- **WHEN** a subsequent `GET /api/terminal/executions/:id` query is made
- **THEN** the response status is `200`
- **AND** the row contains `command: "echo hi"`, `status: "completed"`, `exit_code: 0`, and a non-zero `duration_ms`

#### Scenario: Spawn-failure path still produces an audit row

- **GIVEN** a stub spawn that throws `ENOENT` synchronously
- **WHEN** the operator runs a command
- **THEN** an audit row exists with `status: "error"`, no `exit_code`, and the error mentioned in `stderr`

### Requirement: Audit Log Endpoints

The system SHALL expose:

- `GET /api/terminal/executions?limit=&before=` — paginated, sorted `started_at DESC`. `limit` defaults to 50, max 200. `before` is an epoch-ms cursor.
- `GET /api/terminal/executions/:id` — full row.

There is intentionally no DELETE — the audit log is append-only.

#### Scenario: List returns most recent first

- **GIVEN** three executions ran in order A, B, C
- **WHEN** a client `GET /api/terminal/executions?limit=10`
- **THEN** the response array is `[C, B, A]`

#### Scenario: GET unknown id → 404

- **WHEN** a client `GET /api/terminal/executions/nope`
- **THEN** the response status is `404`
