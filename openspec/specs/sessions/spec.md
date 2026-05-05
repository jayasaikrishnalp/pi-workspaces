# Sessions Spec

## Purpose

Owns session lifecycle: POST /api/sessions allocates a new sessionKey; GET /api/sessions enumerates; GET /api/sessions/:sessionKey/active-run reports the in-flight runId for dedup. The live chat SSE channel (GET /api/chat-events) filters by sessionKey.

## Requirements

### Requirement: Create Session

The system SHALL expose `POST /api/sessions` that allocates a fresh `sessionKey` (UUIDv4), records it in the in-memory session registry, and returns it.

#### Scenario: Create returns 201 with sessionKey

- **GIVEN** the workspace is running
- **WHEN** a client sends `POST /api/sessions`
- **THEN** the response status is `201`
- **AND** the body matches `{"sessionKey": <uuidv4>}`
- **AND** the same `sessionKey` is subsequently accepted by `POST /api/send-stream`

### Requirement: List Sessions

The system SHALL expose `GET /api/sessions` returning the set of currently-known sessionKeys as JSON.

#### Scenario: List enumerates created sessions

- **GIVEN** two `POST /api/sessions` calls returned `s1` and `s2`
- **WHEN** a client sends `GET /api/sessions`
- **THEN** the response status is `200`
- **AND** the body matches `{"sessions": [{"sessionKey":"s1", ...}, {"sessionKey":"s2", ...}]}` in any order

### Requirement: Active-Run Lookup

The system SHALL expose `GET /api/sessions/:sessionKey/active-run` returning the in-flight runId for a session, or `null` if none.

#### Scenario: No active run returns null

- **GIVEN** a session `s1` exists with no active run
- **WHEN** a client sends `GET /api/sessions/s1/active-run`
- **THEN** the response status is `200`
- **AND** the body matches `{"runId": null}`

#### Scenario: Active run returns the runId and status

- **GIVEN** a `POST /api/send-stream` for `sessionKey="s1"` returned `runId="r1"`
- **WHEN** a client sends `GET /api/sessions/s1/active-run` while the run is still running
- **THEN** the response body matches `{"runId":"r1", "status":"running"}`

#### Scenario: After completion the active slot is cleared

- **GIVEN** a run for `sessionKey="s1"` has emitted `run.completed`
- **WHEN** a client sends `GET /api/sessions/s1/active-run`
- **THEN** the response body matches `{"runId": null}`

### Requirement: Live Chat SSE Channel

The system SHALL expose `GET /api/chat-events?sessionKey=<key>&tabId=<id>` as a Server-Sent Events stream that emits every event for that session as the bus publishes it. This channel MUST NOT include backlog — events emitted before the subscription are not delivered.

#### Scenario: Live channel filters by sessionKey

- **GIVEN** the workspace is running and two sessions `s1` and `s2` have runs in flight
- **WHEN** a client opens `GET /api/chat-events?sessionKey=s1&tabId=t1`
- **THEN** the SSE messages delivered all carry `meta.sessionKey === "s1"`
- **AND** no events from session `s2` reach the client

#### Scenario: Missing sessionKey returns 400

- **WHEN** a client opens `GET /api/chat-events?tabId=t1` (no sessionKey)
- **THEN** the response status is `400`
