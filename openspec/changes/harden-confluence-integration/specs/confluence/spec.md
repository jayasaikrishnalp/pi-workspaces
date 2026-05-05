# Delta: confluence

## ADDED Requirements

### Requirement: Search Endpoint

The system SHALL expose `POST /api/confluence/search` accepting JSON `{query: string, limit?: number}`. The handler MUST:

- Reject `query` longer than 200 characters with `400 INVALID_INPUT`.
- Clamp `limit` to `[1, 20]`; default `5` when omitted.
- Build CQL server-side; clients MUST NOT be able to inject CQL through `query`.
- Use `AbortSignal.timeout(10_000)` on every outbound request.
- Cache successful responses for 5 minutes keyed on `(query, limit)`.

#### Scenario: Search with simple text returns hits

- **GIVEN** the workspace has a configured Confluence client
- **WHEN** a client sends `POST /api/confluence/search {query:"runbook patching"}`
- **AND** Atlassian returns three results
- **THEN** the response status is `200`
- **AND** the body matches `{"hits":[{"id":<string>,"title":<string>,"snippet":<string>,"url":<string>}, ...]}` with three entries

#### Scenario: Query too long is rejected

- **WHEN** a client sends `POST /api/confluence/search` with a 250-character query
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"INVALID_INPUT", ...}}`

#### Scenario: limit is clamped

- **GIVEN** the workspace's Confluence client
- **WHEN** a client sends `POST /api/confluence/search {query:"x", limit:9999}`
- **THEN** the outbound Atlassian request includes `limit=20`, not the caller's value

#### Scenario: CQL injection through query is defanged

- **WHEN** a client sends `POST /api/confluence/search {query:"foo\" OR space=\"private"}`
- **THEN** the outbound Atlassian CQL string contains the entire user input as a quoted text term
- **AND** does NOT introduce a new boolean clause derived from the user input

### Requirement: Get Page Endpoint

The system SHALL expose `GET /api/confluence/page/:pageId?maxChars=<int>`. The handler MUST:

- Reject `pageId` not matching `/^\d+$/` with `400 INVALID_PAGE_ID`.
- Clamp `maxChars` to `[256, 16000]`; default `8000`.
- Sanitize the page body via `sanitize-html` with a strict allowlist (script/style/event-handlers stripped).
- Wrap the sanitized body in `<external_content trusted="false" source="confluence" page-id="<id>">…</external_content>` markers.
- Cache successful responses for 5 minutes keyed on `(pageId, maxChars)`.

#### Scenario: Path-traversal pageId is rejected

- **WHEN** a client sends `GET /api/confluence/page/../../etc/passwd`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"INVALID_PAGE_ID", ...}}`
- **AND** no outbound HTTP call is made

#### Scenario: Page body is sanitized and wrapped

- **GIVEN** Atlassian returns a page whose body contains `<script>alert(1)</script><p>hello</p>`
- **WHEN** the workspace serves `GET /api/confluence/page/12345`
- **THEN** the response body's `content` field starts with `<external_content trusted="false" source="confluence" page-id="12345">`
- **AND** ends with `</external_content>`
- **AND** the `<script>` tag is absent
- **AND** the `<p>hello</p>` content survives

#### Scenario: maxChars truncates oversized content

- **GIVEN** a page body 12000 characters long
- **WHEN** a client sends `GET /api/confluence/page/12345?maxChars=1000`
- **THEN** the response `content.length` is no greater than `1000` plus the marker wrapper length plus an ellipsis

### Requirement: Allowlisted Base URL

The system SHALL refuse to construct a Confluence client unless `CONFLUENCE_BASE_URL` matches `^https://wkengineering\.atlassian\.net$`. A misconfigured base URL MUST surface to the routes as `503 CONFLUENCE_UNAVAILABLE`.

#### Scenario: Misconfigured base URL produces 503

- **GIVEN** the workspace started with `CONFLUENCE_BASE_URL=https://example.com`
- **WHEN** a client sends any `/api/confluence/*` request
- **THEN** the response status is `503`
- **AND** the body matches `{"error":{"code":"CONFLUENCE_UNAVAILABLE", ...}}`

### Requirement: Auth Token Sourcing

The system SHALL read the API token from `ATLASSIAN_API_TOKEN`, falling back to `JIRA_TOKEN` when the former is unset. The email comes from `ATLASSIAN_EMAIL`. If neither token is set the client MUST be considered unconfigured.

#### Scenario: ATLASSIAN_API_TOKEN takes precedence over JIRA_TOKEN

- **GIVEN** both `ATLASSIAN_API_TOKEN=A` and `JIRA_TOKEN=J` are set
- **WHEN** the client makes an outbound request
- **THEN** the `Authorization` header is built from token `A`

#### Scenario: JIRA_TOKEN is honored when ATLASSIAN_API_TOKEN is unset

- **GIVEN** only `JIRA_TOKEN=J` is set
- **WHEN** the client makes an outbound request
- **THEN** the `Authorization` header is built from token `J`

### Requirement: Error Redaction And Normalization

The system SHALL convert Atlassian error responses to normalized workspace error codes WITHOUT forwarding the raw response body to clients. The mapping is:

- `401` → `AUTH_REQUIRED`
- `403` → `FORBIDDEN`
- `429` → `RATE_LIMITED`
- `5xx` → `EXTERNAL_API_ERROR`
- timeout → `TIMEOUT`

#### Scenario: 401 from Atlassian is surfaced as AUTH_REQUIRED with no raw body

- **GIVEN** Atlassian returns `401` with body `{"errorMessages":["Token expired", "<internal stack trace>"]}`
- **WHEN** the workspace's `/api/confluence/search` is called
- **THEN** the response status is `401`
- **AND** the body matches `{"error":{"code":"AUTH_REQUIRED","message":<string>,"ts":<integer>}}`
- **AND** the response body does NOT contain the substring `internal stack trace`

#### Scenario: Slow Atlassian triggers TIMEOUT

- **GIVEN** Atlassian does not respond within 10 seconds
- **WHEN** the workspace's `/api/confluence/search` is called
- **THEN** the response status is `504`
- **AND** the body matches `{"error":{"code":"TIMEOUT", ...}}`

### Requirement: 5-Minute Cache

The system SHALL cache successful search and page-fetch responses for 5 minutes keyed on the request shape. Cache hits MUST NOT issue an outbound HTTP call.

#### Scenario: Repeat search within 5 min is served from cache

- **GIVEN** a successful `POST /api/confluence/search {query:"x"}` issued at t=0
- **WHEN** the same request is reissued at t=120 seconds
- **THEN** the workspace responds without invoking the outbound `fetch`
- **AND** the response body is byte-equal to the first response

#### Scenario: Cache expires after TTL

- **GIVEN** a successful response at t=0 with TTL=5 minutes
- **WHEN** the same request is reissued at t=400 seconds
- **THEN** a fresh outbound `fetch` is issued
