# Server Spec

## Purpose

Owns the workspace's HTTP listener: process lifecycle, port handling, signal handling, and the catch-all 404 envelope. Every other domain plugs routes into this dispatcher; none of them re-implement boot or shutdown.

## Requirements

### Requirement: HTTP Listener

The system SHALL provide an HTTP server that listens on a configurable port and accepts connections.

#### Scenario: Server boots on configured port

- **GIVEN** the workspace process is started with `PORT=8767` in the environment
- **WHEN** the server has finished initialization
- **THEN** the server is accepting TCP connections on `127.0.0.1:8767`
- **AND** the server logs a startup line including the bound port and version (e.g., `[server] listening on http://127.0.0.1:8767 (v0.1.0)`)

#### Scenario: Default port when PORT unset

- **GIVEN** the workspace process is started without a `PORT` environment variable
- **WHEN** the server initializes
- **THEN** the server listens on the documented default port `8766`

#### Scenario: Port collision exits non-zero with a clear hint

- **GIVEN** another process already binds `127.0.0.1:8766`
- **WHEN** the workspace process is started without a `PORT` override
- **THEN** the server logs an error containing the string `EADDRINUSE` and the bound port
- **AND** the process exits with a non-zero status code

### Requirement: Graceful Shutdown

The system SHALL terminate cleanly on SIGTERM or SIGINT, draining in-flight responses within a bounded time.

#### Scenario: SIGTERM exits cleanly within 5 seconds

- **GIVEN** the server is running and idle
- **WHEN** the process receives `SIGTERM`
- **THEN** the server stops accepting new connections
- **AND** the process exits with code `0` within 5 seconds

#### Scenario: SIGINT (Ctrl+C) is treated like SIGTERM

- **GIVEN** the server is running and idle
- **WHEN** the process receives `SIGINT`
- **THEN** the server stops accepting new connections
- **AND** the process exits with code `0` within 5 seconds

### Requirement: Unknown Routes Return 404

The system SHALL respond to requests for unknown HTTP paths with status `404` and a JSON error body.

#### Scenario: Unknown path returns structured 404

- **GIVEN** the server is running
- **WHEN** a client sends `GET /api/does-not-exist`
- **THEN** the response status is `404`
- **AND** the response body is a JSON object matching `{"error":{"code":"NOT_FOUND","message":<string>,"ts":<integer>}}`
- **AND** the `Content-Type` response header is `application/json`
