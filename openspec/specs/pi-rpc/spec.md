# Pi-RPC Spec

## Purpose

Owns the workspace's connection to the pi --mode rpc child process: spawn, prompt send, JSON-line parsing, restart-on-crash, BRIDGE_BUSY rejection, and synthesizing terminal events on pi failure. Stage 1's pi-event-mapper translates raw events; this domain is what feeds it.

## Requirements

### Requirement: Single Long-Lived Pi Child

The system SHALL spawn at most one `pi --mode rpc` child process per workspace, reuse it across all prompts in the same workspace lifetime, and lazily spawn it on first use.

#### Scenario: First prompt spawns pi

- **GIVEN** the workspace has just started and no pi child has been spawned
- **WHEN** the workspace receives `POST /api/send-stream` with a valid sessionKey and a message
- **THEN** the workspace spawns exactly one pi child as a detached process with its own process group
- **AND** subsequent `POST /api/send-stream` calls in the same workspace lifetime do not spawn additional children

#### Scenario: Pi crash respawns on next prompt

- **GIVEN** the pi child has exited (any reason)
- **WHEN** a new `POST /api/send-stream` request arrives
- **THEN** the workspace spawns a fresh pi child before sending the prompt
- **AND** the previous child's PID is no longer used

### Requirement: One Prompt In Flight Per Workspace

The system SHALL accept at most one `POST /api/send-stream` for a given session at a time. A second concurrent submission MUST be rejected with HTTP 409 and a structured error body. The rejection MUST occur before any prompt is written to pi's stdin.

#### Scenario: Concurrent prompt is rejected

- **GIVEN** a prompt is already running for `sessionKey="s1"` with `runId="r1"`
- **WHEN** the workspace receives a second `POST /api/send-stream {sessionKey:"s1", message:"another"}`
- **THEN** the response status is `409`
- **AND** the response body matches `{"error":{"code":"ACTIVE_RUN", "message":<string>, "details":{"sessionKey":"s1", "activeRunId":"r1"}, "ts":<integer>}}`
- **AND** no new run is created and no command is written to pi

#### Scenario: New prompt allowed after run finishes

- **GIVEN** a prompt has finished (`run.completed` was emitted) for `sessionKey="s1"`
- **WHEN** the workspace receives a new `POST /api/send-stream {sessionKey:"s1", message:"next"}`
- **THEN** the response status is `202`
- **AND** the body contains `{runId:<uuid>}`

### Requirement: Pi Errors Surface As Events

The system SHALL convert pi child failures (crash, write error, malformed JSON line) into a `pi.error` event on the active run, set the run's status to `error`, and emit a `run.completed` with `status:"error"` so SSE clients see a clean termination.

#### Scenario: Pi child exits unexpectedly during a run

- **GIVEN** a run is in flight and the pi child exits with a non-zero code
- **WHEN** the workspace observes the exit
- **THEN** the active run's persisted events conclude with a `pi.error` event followed by a `run.completed` with `status:"error"`
- **AND** the run's `meta.json` `status` is `"error"`
- **AND** the active-run tracker has cleared the slot for the affected sessionKey
