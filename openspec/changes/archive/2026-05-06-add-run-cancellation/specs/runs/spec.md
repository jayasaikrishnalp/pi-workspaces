# Delta: runs

## ADDED Requirements

### Requirement: Cancel A Running Run

The system SHALL expose `POST /api/runs/:runId/abort` accepting no body. On a run that is currently `running` or `cancelling`, the workspace MUST initiate the cancellation flow described in §2.5 of the locked spec. The response MUST be one of:

- `202 {cancelled: true}` — abort was issued.
- `200 {alreadyFinished: true}` — the run is already in a terminal status (`success`, `error`, `cancelled`).
- `404` with code `UNKNOWN_RUN` — the run does not exist.

#### Scenario: Abort a running run returns 202 and emits run.cancelling

- **GIVEN** a run `r1` is in flight with `meta.status === "running"`
- **WHEN** a client sends `POST /api/runs/r1/abort`
- **THEN** the response is `202` with body `{cancelled: true}`
- **AND** before the response was sent, the run's `meta.status` was atomically transitioned to `"cancelling"`
- **AND** a `run.cancelling` event was persisted to the run's `events.jsonl` and emitted on the chat-event bus

#### Scenario: Abort an already-finished run returns 200

- **GIVEN** a run `r1` whose `meta.status` is `success` (or `error` / `cancelled`)
- **WHEN** a client sends `POST /api/runs/r1/abort`
- **THEN** the response is `200` with body `{alreadyFinished: true}`
- **AND** no `run.cancelling` event is emitted
- **AND** `meta.status` is unchanged

#### Scenario: Abort an unknown run returns 404

- **GIVEN** no run exists with id `bogus`
- **WHEN** a client sends `POST /api/runs/bogus/abort`
- **THEN** the response is `404` with code `UNKNOWN_RUN`

### Requirement: Cancellation Status Transition

The system SHALL transition a cancelled run through `running → cancelling → cancelled`. The first transition MUST be atomic (CAS expected = `running`). The final transition (`cancelling → cancelled`) MUST also accept `running` as the expected, so that a stale path that skipped the cancelling state still settles cleanly. If `agent_end` arrives before the second CAS lands and flips the run to `success`, the run MUST stay `success`.

#### Scenario: agent_end first wins — successful run is not flipped to cancelled

- **GIVEN** a run is `running` and a `POST /api/runs/<id>/abort` has marked it `cancelling`
- **WHEN** pi emits `agent_end` with no failure (mapper produces `run.completed status:"success"`) before the abort RPC reaches pi
- **THEN** `meta.status` becomes `success`
- **AND** the bus emits exactly one `run.completed` event with `status:"success"`
- **AND** no later `run.completed status:"cancelled"` is emitted

#### Scenario: Idempotent abort — calling abort twice does not double-emit

- **GIVEN** a run that has already been aborted and its `run.completed status:"cancelled"` has been emitted
- **WHEN** a client sends `POST /api/runs/<id>/abort` again
- **THEN** the response is `200 {alreadyFinished: true}`
- **AND** no additional events are emitted on the bus

### Requirement: Replay Channel Surfaces Cancellation

The system's replay-aware SSE channel (`GET /api/runs/:runId/events`) SHALL deliver the `run.cancelling` and final `run.completed` events for a cancelled run, in seq order, just like any other run.

#### Scenario: Replay of a cancelled run includes run.cancelling and run.completed status:cancelled

- **GIVEN** a run that has been cancelled and is now in `meta.status === "cancelled"`
- **WHEN** a client opens `GET /api/runs/<id>/events?afterSeq=0`
- **THEN** the SSE event sequence includes both a `run.cancelling` event and a final `run.completed` event with `status:"cancelled"`
- **AND** the stream ends cleanly after `run.completed`
