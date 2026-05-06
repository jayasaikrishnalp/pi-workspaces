# Delta: tasks

## ADDED Requirements

### Requirement: Tasks Table And State Machine

The system SHALL persist tasks in the `tasks` SQLite table. Each task MUST have a status from `triage|todo|ready|running|blocked|done|archived` and a source from `operator|agent`. Allowed state transitions:

- `triage → todo | ready | archived`
- `todo → ready | blocked | archived`
- `ready → running | blocked | archived`
- `running → done | blocked | failed | archived` (`failed` collapses to `archived` for terminal queries)
- `blocked → todo | ready | archived`
- Terminal: `done`, `archived`

The server MUST reject illegal transitions with `409 INVALID_TRANSITION`.

#### Scenario: Forward transition allowed

- **GIVEN** a task in `status:"todo"`
- **WHEN** a client `PUT /api/tasks/:id {status:"ready"}`
- **THEN** the response status is `200` and the stored status is `ready`

#### Scenario: Backwards from done blocked

- **GIVEN** a task in `status:"done"`
- **WHEN** a client `PUT /api/tasks/:id {status:"todo"}`
- **THEN** the response status is `409 INVALID_TRANSITION`

### Requirement: Operator + Agent Source

The system SHALL record `source:"operator"` for tasks created via `POST /api/tasks` from an authenticated operator without an explicit override, and `source:"agent"` when the request body includes `source:"agent"` AND the request originated from a tool-calling pathway. Both sources land in the same table; the `source` field exists for filtering and UI presentation, not for access control.

#### Scenario: Operator-created task has source=operator by default

- **WHEN** a client `POST /api/tasks {title:"check disk"}`
- **THEN** the created row has `source="operator"`

#### Scenario: Listing operator-only tasks

- **GIVEN** the table contains 2 operator and 3 agent tasks
- **WHEN** a client `GET /api/tasks?source=operator`
- **THEN** the response contains exactly 2 tasks

### Requirement: Tasks CRUD

The system SHALL expose:

- `GET /api/tasks?status=&source=&assignee=&limit=` — list with optional filters, sorted by `(status, priority ASC, created_at DESC)`.
- `POST /api/tasks` accepting `{title, body?, status?, priority?, source?, assignee_soul_id?, parent_task_id?, linked_job_id?, idempotency_key?}`. `status` defaults to `triage`, `source` defaults to `operator`, `priority` defaults to `0`. `idempotency_key`, when supplied, MUST be unique — duplicate POSTs return the existing row's `id` with `200`, not a new insert.
- `GET /api/tasks/:id` — returns the full row.
- `PUT /api/tasks/:id` — patch semantics for `title`, `body`, `status`, `priority`, `assignee_soul_id`. State transitions go through the state machine.
- `DELETE /api/tasks/:id` — sets status to `archived`. Hard-delete is not exposed.

#### Scenario: Idempotency-key dedup

- **WHEN** a client POSTs twice with the same `idempotency_key="abc"`
- **THEN** both responses return the same task `id`
- **AND** only one row exists in the table
