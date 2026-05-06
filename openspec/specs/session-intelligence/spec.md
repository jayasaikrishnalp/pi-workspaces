# Session Intelligence Spec

## Purpose

Capture every assistant turn pi emits into the workspace SQLite (chat_messages with token + cost + model columns), and surface it as a Hermes-style dashboard with seven widgets: 4 hero stat cards (SESSIONS / TOKENS / API CALLS / ACTIVE MODEL), Usage Trend, Top Models, Cache Contribution (honestly labeled — not "hit rate"), Sessions Intelligence (with TOOL_HEAVY / HIGH_TOKEN / STALE tags), Mix & Rhythm (token type breakdown + 24h UTC histogram), Tools Usage. The data flows through a single chat-event-bus subscriber (idempotent ON CONFLICT DO NOTHING); the read endpoint is one GET /api/dashboard/intelligence?window=1..90 days.

## Requirements



### Requirement: Pi-Event-Mapper Preserves Usage

The system's pi-event-mapper SHALL pass `usage` and `usage.cost` through unchanged on `assistant.start`, `message_end` (assistant role only), `agent_end`, and `turn_end` events. Existing event names + payloads MUST stay backward-compatible; the addition is an optional `data.usage` field.

#### Scenario: Mapper preserves usage on assistant message_end

- **GIVEN** a raw pi event of `type=message_end` whose `message.role` is `"assistant"` and whose `message.usage` carries `{input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: {input: 0.0001, output: 0.00005, cacheRead: 0, cacheWrite: 0, total: 0.00015}}`
- **WHEN** the mapper normalizes the event
- **THEN** the resulting normalized event has `data.usage` equal to that object verbatim
- **AND** all existing fields on the event (text, messageId, etc.) are still present

#### Scenario: User-role message_end has no usage field added

- **GIVEN** a raw pi event of `type=message_end` whose `message.role` is `"user"` (no usage in pi's payload)
- **WHEN** the mapper normalizes
- **THEN** `data.usage` is absent (not `null`, not `{}`)

### Requirement: Chat Persister

The system SHALL ship one `chat-event-bus` subscriber that writes a row to `chat_messages` for every assistant `message_end` event and every `tool.call.start` event. Each write MUST be idempotent: a duplicate `id` (whether from retry or replay) MUST collapse to no-op via `INSERT ... ON CONFLICT(id) DO NOTHING`. A persistence failure MUST be logged via `console.error` but MUST NOT propagate to other subscribers (the chat-events SSE consumer must keep working even if the persister throws).

#### Scenario: Assistant message_end persists with full usage

- **GIVEN** the chat-event-bus emits an enriched assistant `message_end` with `messageId="m1"`, `runId="r1"`, `meta.sessionKey="sess_1234_abcdef"`, content `"Hello"`, model `"claude-sonnet-4.6"`, provider `"anthropic"`, and the usage object above
- **WHEN** the persister processes the event
- **THEN** `SELECT * FROM chat_messages WHERE id = 'm1'` returns one row with `tokens_in=10`, `tokens_out=5`, `cache_read=2`, `cache_write=0`, `cost_usd=0.00015`, `model="claude-sonnet-4.6"`, `provider="anthropic"`, `role="assistant"`

#### Scenario: Duplicate message_end is a no-op

- **GIVEN** a row already exists in `chat_messages` with `id="m1"`
- **WHEN** the persister receives a second `message_end` with the same id
- **THEN** the existing row is unchanged
- **AND** no error propagates

#### Scenario: Persister error does not block the bus

- **GIVEN** the persister's database handle is closed (forced failure)
- **WHEN** an enriched assistant `message_end` is emitted
- **THEN** the persister logs the failure
- **AND** other subscribers (chat-events SSE) still receive the event

### Requirement: Stable Session ID

Every session SHALL have a `sessionKey` matching the regex `/^sess_\d+_[a-z0-9]{6}$/` (`sess_<epochMs>_<rand6>`). The format is fixed and survives Phase B (per-session folders); existing rows remain queryable.

#### Scenario: Session creation produces an id matching the regex

- **WHEN** a client `POST /api/sessions`
- **THEN** the response body's `sessionKey` matches `/^sess_\d+_[a-z0-9]{6}$/`

### Requirement: Dashboard Intelligence Endpoint

The system SHALL expose `GET /api/dashboard/intelligence?window=<N>d` returning a JSON payload of every aggregation needed by the dashboard. `window` MUST be in the closed range `[1, 90]`; out-of-range yields `400 INVALID_WINDOW` with `error.message` listing the allowed range. The response shape is the typed `DashboardIntelligence` interface (declared in `src/types/dashboard.ts`).

#### Scenario: Endpoint returns the full payload for the window

- **GIVEN** the database has 3 sessions of activity in the last 7 days
- **WHEN** an authenticated client `GET /api/dashboard/intelligence?window=7d`
- **THEN** the response status is `200`
- **AND** the body has fields: `sessionsCount`, `tokenTotals`, `apiCallsCount`, `topModels`, `cacheContribution`, `usageTrend`, `sessionsIntelligence`, `hourOfDayHistogram`, `tokenMix`, `topTools`, `windowDays`

#### Scenario: Out-of-range window rejected

- **WHEN** a client requests `?window=100d`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"INVALID_WINDOW", "message": ...}}`

### Requirement: Cache Contribution Formula

`cacheContribution` SHALL compute `cache_read / (cache_read + cache_write + tokens_in)` summed over the window, returning `0` when the denominator is zero. Widgets consuming this value MUST label it "Cache contribution" — never "hit rate" — to remain honest about Anthropic's cache mechanic.

#### Scenario: Cache contribution returns 0 with no rows

- **GIVEN** the chat_messages table is empty for the window
- **WHEN** the endpoint returns `cacheContribution`
- **THEN** the value is `0`

#### Scenario: Cache contribution is non-trivial when cache_read dominates

- **GIVEN** rows in the window summing to `cache_read=900, cache_write=10, tokens_in=90`
- **WHEN** the endpoint returns `cacheContribution`
- **THEN** the value is `0.9` (within float tolerance)

### Requirement: Sessions Intelligence Tags

`sessionsIntelligence` SHALL surface explicit boolean tags per session computed by named constants:

- `STALE` = `now - last_activity > 7 days` AND `now - last_activity > 48 hours` (i.e., stale and inactive)
- `TOOL_HEAVY` = `tool_count > 20`
- `HIGH_TOKEN` = `total_tokens > 100_000`

The thresholds MUST be defined as named constants in `src/server/dashboard-intelligence.ts` so they can be tuned without code spelunking.

#### Scenario: Session with 25 tool calls is TOOL_HEAVY

- **GIVEN** a session has 25 rows where `tool_name IS NOT NULL`
- **WHEN** sessionsIntelligence returns
- **THEN** that session entry has `tags` including `"TOOL_HEAVY"`

#### Scenario: Session inactive for 8 days is STALE

- **GIVEN** the most recent assistant `message_end` for a session was 8 days ago
- **WHEN** sessionsIntelligence returns
- **THEN** that session entry has `tags` including `"STALE"`

### Requirement: Frontend Renders The Seven Widgets

The Dashboard SHALL render the following widgets, each backed by `GET /api/dashboard/intelligence`:

1. Hero stat strip: SESSIONS / TOKENS / API CALLS / ACTIVE MODEL with sparklines.
2. USAGE TREND line chart with 7D/14D/30D toggle and peak/top-tool callouts.
3. TOP MODELS ranked list with bars + cost per model.
4. CACHE CONTRIBUTION card with hit-percent display labeled "Cache contribution".
5. SESSIONS INTELLIGENCE scrollable list with `TOOL_HEAVY`/`HIGH_TOKEN`/`STALE` tags.
6. MIX & RHYTHM stacked bar (token type breakdown) + 24h histogram (UTC).
7. TOOLS USAGE ranked bar list.

Recharts MAY be used for items 2, 6 (line + histogram + stacked bar). Items 1, 3, 4, 5, 7 SHOULD be hand-rolled SVG / DOM to keep the bundle lean.

#### Scenario: Dashboard renders all seven widgets

- **GIVEN** an authenticated operator with a populated workspace
- **WHEN** the dashboard loads
- **THEN** every widget testid (`dash-hero`, `dash-usage-trend`, `dash-top-models`, `dash-cache`, `dash-sessions-intel`, `dash-mix-rhythm`, `dash-tools-usage`) is visible

#### Scenario: Window selector switches the data

- **GIVEN** the dashboard is showing 7D
- **WHEN** the operator clicks `30D`
- **THEN** the API was hit once with `?window=30d`
- **AND** widget data updates to the 30-day aggregates
