# Delta: runs

## ADDED Requirements

### Requirement: Submit a Prompt

The system SHALL expose `POST /api/send-stream` accepting JSON `{sessionKey: string, message: string}`. On success it MUST allocate a fresh `runId` (UUIDv4), record the run as in-flight for that session, write the prompt to pi, and respond `202` with `{runId}`. The response MUST be returned before any pi events are produced.

#### Scenario: Successful submission returns 202 with runId

- **GIVEN** a previously-created session `sessionKey="s1"` with no active run
- **WHEN** a client sends `POST /api/send-stream {sessionKey:"s1", message:"hello"}`
- **THEN** the response status is `202`
- **AND** the response body matches `{"runId": <uuidv4>}`
- **AND** the active-run tracker reports `getActive("s1") === <runId from response>` immediately after the call returns

#### Scenario: Unknown session is rejected

- **GIVEN** no session has been created with `sessionKey="bogus"`
- **WHEN** a client sends `POST /api/send-stream {sessionKey:"bogus", message:"hi"}`
- **THEN** the response status is `404`
- **AND** the body matches `{"error":{"code":"UNKNOWN_SESSION", ...}}`

#### Scenario: Missing or wrong-typed body is rejected

- **GIVEN** the server is running
- **WHEN** a client sends `POST /api/send-stream` with body `{}` or `{sessionKey:"s1"}` or `{sessionKey:"s1", message: 42}`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"BAD_REQUEST", "message":<string>, "details":<object>, "ts":<integer>}}`

### Requirement: Persistent Per-Run Event Log

The system SHALL persist every event emitted for a run to disk before publishing it to bus subscribers. Each persisted event MUST carry a per-run-monotonic integer `seq` (starting at 1) and an `eventId` of the form `"${runId}:${seq}"`. The disk layout MUST be `~/.pi-workspace/runs/<runId>/events.jsonl` (append-only, one JSON event per line) plus `~/.pi-workspace/runs/<runId>/meta.json` (run status + metadata).

#### Scenario: Events have monotonic seq and unique eventId

- **GIVEN** a successful `POST /api/send-stream` returning `runId="<uuid>"`
- **WHEN** the run completes
- **THEN** every line of `~/.pi-workspace/runs/<uuid>/events.jsonl` parses as JSON
- **AND** the `meta.seq` values across the file are strictly increasing integers starting at `1` with no gaps and no duplicates
- **AND** the `meta.eventId` of each line equals `"${runId}:${seq}"` and is unique

#### Scenario: Disk write happens before bus emit

- **GIVEN** a run is in flight
- **WHEN** the bridge produces a normalized event
- **THEN** the event is appended to `events.jsonl` and `seq.txt` is updated before any bus subscriber's handler runs

### Requirement: Replay-Aware Per-Run SSE Channel

The system SHALL expose `GET /api/runs/:runId/events?afterSeq=<int>` as a Server-Sent Events stream. The handler MUST:

1. Subscribe to the bus BEFORE reading the persisted backlog.
2. Drain the backlog from disk filtered by `seq > afterSeq`, writing each event as an SSE message with `id: <eventId>`, `event: <event name>`, `data: <JSON>`.
3. Flush any events the bus delivered during the drain (deduping by numeric `seq`).
4. Switch to live streaming using the same handler — no re-subscribe.

When the run has already terminated and the backlog has been fully delivered, the handler MUST close the response with a final SSE comment instead of waiting for new live events.

#### Scenario: Replay from start delivers every event in seq order

- **GIVEN** a completed run `runId="r1"` whose `events.jsonl` contains events with `seq` 1..N
- **WHEN** a client opens `GET /api/runs/r1/events?afterSeq=0`
- **THEN** the response is `200` with `Content-Type: text/event-stream`
- **AND** the SSE messages received are exactly the events at seq 1..N, in order, each with `id` matching `eventId`
- **AND** the response stream ends after seq N without hanging

#### Scenario: Replay with afterSeq skips earlier events

- **GIVEN** a completed run with seqs 1..10
- **WHEN** a client opens `GET /api/runs/<id>/events?afterSeq=4`
- **THEN** the SSE messages received are exactly seqs 5..10

#### Scenario: Live capture during a running run

- **GIVEN** a run is in flight with seqs 1..3 already persisted
- **WHEN** a client opens `GET /api/runs/<id>/events?afterSeq=0`
- **THEN** the client receives seqs 1..3 immediately
- **AND** the client continues to receive subsequent events as they are produced (one for each new event the bridge emits) until `run.completed`

#### Scenario: Invalid afterSeq is rejected

- **GIVEN** a run exists
- **WHEN** a client opens `GET /api/runs/<id>/events?afterSeq=-1` or `?afterSeq=abc`
- **THEN** the response status is `400`
- **AND** no SSE handshake is performed

#### Scenario: Unknown runId returns 404

- **GIVEN** no run exists with id `"bogus"`
- **WHEN** a client opens `GET /api/runs/bogus/events`
- **THEN** the response status is `404`

### Requirement: Run Status Transitions

The system SHALL transition a run's status atomically through `running → success | error | cancelled`. The `meta.json` write MUST be atomic (tmp+rename). A status transition MUST happen exactly once per run; subsequent attempts to transition from a terminal state MUST be no-ops.

#### Scenario: A successful run lands in success status

- **GIVEN** a run that completes with `agent_end` carrying no failure
- **WHEN** the bridge emits the final `run.completed` event
- **THEN** `meta.json.status === "success"` after the disk write completes
- **AND** `meta.json.finishedAt` is a positive integer timestamp

#### Scenario: A pi crash flips status to error

- **GIVEN** a run is `"running"`
- **WHEN** the pi child exits unexpectedly
- **THEN** `meta.json.status` becomes `"error"` and `meta.json.error` is a non-empty string
