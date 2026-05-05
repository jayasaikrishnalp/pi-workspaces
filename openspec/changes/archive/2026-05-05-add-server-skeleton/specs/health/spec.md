# Delta: health

## ADDED Requirements

### Requirement: Liveness Endpoint

The system SHALL expose a `GET /api/health` endpoint that returns liveness status without requiring authentication.

#### Scenario: Healthy response shape

- **GIVEN** the server is running
- **WHEN** a client sends `GET /api/health`
- **THEN** the response status is `200`
- **AND** the response body parses as JSON matching `{"ok": true, "version": <string>}`
- **AND** the `version` field is a semver string (e.g., `"0.1.0"`)
- **AND** the `Content-Type` response header is `application/json`

#### Scenario: Endpoint requires no authentication

- **GIVEN** the server is running and no session cookie is present
- **WHEN** a client sends `GET /api/health` with no `Cookie` and no `Authorization` header
- **THEN** the response status is `200` (not `401`)

#### Scenario: Wrong method returns 405

- **GIVEN** the server is running
- **WHEN** a client sends `POST /api/health` (or `PUT`, `DELETE`, `PATCH`)
- **THEN** the response status is `405`
- **AND** the response includes an `Allow: GET` header
- **AND** the body is a JSON object matching `{"error":{"code":"METHOD_NOT_ALLOWED","message":<string>,"ts":<integer>}}`
