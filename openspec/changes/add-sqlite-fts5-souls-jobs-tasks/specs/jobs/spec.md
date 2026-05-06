# Delta: jobs

## ADDED Requirements

### Requirement: Jobs Table And State Machine

The system SHALL persist jobs in the `jobs` SQLite table. Each job MUST have a status from `queued|running|completed|failed|cancelled`. Allowed state transitions:

- `queued → running | cancelled`
- `running → completed | failed | cancelled`
- Terminal: `completed`, `failed`, `cancelled`

Server-side handlers MUST reject illegal transitions with `409 INVALID_TRANSITION`. The transition check is performed inside `BEGIN IMMEDIATE` to prevent race conditions.

#### Scenario: Cancelling a queued job moves it to cancelled

- **GIVEN** a job in `status:"queued"`
- **WHEN** a client `POST /api/jobs/:id/cancel`
- **THEN** the job's status becomes `cancelled` and `completed_at` is set

#### Scenario: Cancelling a completed job is a no-op error

- **GIVEN** a job in `status:"completed"`
- **WHEN** a client `POST /api/jobs/:id/cancel`
- **THEN** the response status is `409 INVALID_TRANSITION`
- **AND** the job's stored status is unchanged

### Requirement: Job Auto-Creation On Chat Send

The system SHALL create a `queued` Job for every successful `POST /api/sessions/:k/send-stream` request before forwarding to the pi-rpc-bridge. The Job's `run_id` MUST equal the bridge's run id. The bridge MUST transition the Job:

- `queued → running` when the bridge accepts the run.
- `running → completed` when the run-store records normal termination.
- `running → failed` when the run-store records an error.
- `running → cancelled` when an `abort` is acknowledged.

#### Scenario: A chat send creates a queued job that becomes running, then completed

- **GIVEN** a stub bridge that accepts a send and immediately completes
- **WHEN** a client `POST /api/sessions/k/send-stream {input:"hi"}`
- **THEN** within 1 second the `jobs` table contains a row with `run_id=<the run id>`
- **AND** that row's terminal status is `completed`

### Requirement: Jobs List & Detail Endpoints

The system SHALL expose:

- `GET /api/jobs?status=&limit=` — list with optional status filter (csv) and `limit` (default 50, max 200), sorted `created_at DESC`.
- `GET /api/jobs/:id` — returns the full row, with `messageTail` (last 5 chat messages) when the run exists.
- `POST /api/jobs/:id/cancel` — transitions to `cancelled`. If the run is still active, also calls `bridge.abort(runId)`.

There is intentionally no `POST /api/jobs` for v1 — Jobs are created automatically by `send-stream`.

#### Scenario: List filtered by status

- **GIVEN** the jobs table contains 3 `completed` and 2 `failed` jobs
- **WHEN** a client `GET /api/jobs?status=failed`
- **THEN** the response contains exactly the 2 failed jobs
