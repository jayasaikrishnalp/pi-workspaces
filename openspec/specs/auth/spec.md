# Auth Spec

## Purpose

Owns the workspace's single-user authentication: dev token persisted at ~/.pi-workspace/dev-token.txt (mode 0600), issued cookie HttpOnly+SameSite=Lax, sessions persisted to ~/.pi-workspace/sessions.json so they survive restart. Middleware gates every route except /api/health and the auth endpoints themselves.

## Requirements

### Requirement: Cookie-Based Session Auth

The system SHALL authenticate every request EXCEPT `/api/health`, `/api/auth/login`, and `/api/auth/check` against a session cookie named `workspace_session`. A request with a missing or invalid cookie MUST receive `401 AUTH_REQUIRED`.

When `PI_WORKSPACE_AUTH_DISABLED=1` is set in the environment, the middleware MUST be a no-op. This bypass exists for unit/route tests; production deploys leave it unset.

#### Scenario: Unauth request to protected route returns 401

- **GIVEN** the workspace is running with auth enabled and no cookie has been set
- **WHEN** a client sends `GET /api/sessions`
- **THEN** the response status is `401`
- **AND** the body matches `{"error":{"code":"AUTH_REQUIRED", ...}}`

#### Scenario: /api/health is always public

- **GIVEN** the workspace is running with auth enabled
- **WHEN** a client sends `GET /api/health` with no cookie
- **THEN** the response status is `200`

### Requirement: Login Issues A Session Cookie

The system SHALL expose `POST /api/auth/login` accepting JSON `{token}`. On a matching token, the workspace MUST issue a `Set-Cookie: workspace_session=<random-uuid>; HttpOnly; SameSite=Lax; Path=/` header and return `200 {ok:true}`. On a mismatched token, the response MUST be `401 AUTH_REQUIRED` with no cookie.

#### Scenario: Successful login sets the cookie

- **GIVEN** the workspace's dev token is `T`
- **WHEN** a client sends `POST /api/auth/login {token:"T"}`
- **THEN** the response status is `200`
- **AND** the response includes a `Set-Cookie` header for `workspace_session` with `HttpOnly` and `SameSite=Lax`

#### Scenario: Wrong token is rejected without cookie

- **WHEN** a client sends `POST /api/auth/login {token:"wrong"}`
- **THEN** the response status is `401`
- **AND** no `Set-Cookie` header is set

### Requirement: Check Validates The Session

The system SHALL expose `GET /api/auth/check`. With a valid `workspace_session` cookie the response is `200 {ok:true}`; otherwise `401 AUTH_REQUIRED`.

#### Scenario: Authed cookie returns ok

- **GIVEN** a client previously logged in and holds a valid `workspace_session` cookie
- **WHEN** the client sends `GET /api/auth/check` with that cookie
- **THEN** the response status is `200`
- **AND** the body matches `{"ok":true}`

### Requirement: Logout Clears The Cookie

The system SHALL expose `POST /api/auth/logout`. The handler MUST invalidate the session and respond `200 {ok:true}` with a `Set-Cookie: workspace_session=; ... Max-Age=0` header that clears the cookie on the client.

#### Scenario: Logout invalidates a previously valid cookie

- **GIVEN** a client logged in with a valid cookie
- **WHEN** the client sends `POST /api/auth/logout`
- **THEN** the response status is `200`
- **AND** subsequent `GET /api/auth/check` with the same cookie returns `401`

### Requirement: Sessions Survive Server Restart

The system SHALL persist active sessions to `~/.pi-workspace/sessions.json` (mode 0600). After a workspace restart, an existing cookie MUST continue to validate.

#### Scenario: Cookie remains valid after restart

- **GIVEN** a client logged in and obtained a cookie before the workspace restarted
- **WHEN** the workspace process is restarted with the same `~/.pi-workspace/` directory
- **AND** the client sends `GET /api/auth/check` with the original cookie
- **THEN** the response status is `200`
