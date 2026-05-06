# Proposal: Session Intelligence — Capture pi usage + dashboard widgets

## Why

The Hermes-style dashboard the user mocked up has 7 widgets that explain "what's happening in the current session": SESSIONS / TOKENS / API CALLS / ACTIVE MODEL stat strip, Usage Trend, Top Models, Cache Contribution, Sessions Intelligence, Mix & Rhythm, and a usage signal per skill. Everything pi already emits — we just don't read it.

A working VM probe confirms: pi v0.73 emits `usage.cost.{input,output,cacheRead,cacheWrite,total}` on every assistant `message_end`. Github-copilot (flat-rate subscription) reports zero, but direct API providers (anthropic, openai, openrouter, x-ai, deepseek, google) carry real dollar amounts. Our `pi-event-mapper.ts` strips `usage` during normalization, so the chat bus never sees tokens or cost.

## What changes

- **Pi-event-mapper preserves `usage`** on `assistant.start`, `message_end`, `agent_end`. Existing event names unchanged; `data.usage` becomes a passthrough field.
- **Migration 003** extends `chat_messages` with `tokens_in / tokens_out / cache_read / cache_write / cost_usd / model / provider / api / response_id / duration_ms / session_title`. All token columns `INTEGER NOT NULL DEFAULT 0`. `cost_usd REAL NOT NULL DEFAULT 0`. Adds 4 indexes for aggregation: `(session_id, created_at)`, `(created_at)`, `(model)`, `(tool_name)`.
- **`src/server/chat-persister.ts` (NEW)** — single chat-event-bus subscriber that writes one row per assistant `message_end` and one row per `tool.call.start` to `chat_messages`. `INSERT ... ON CONFLICT(id) DO NOTHING` for idempotency. Persistence errors logged but never block the bus emit.
- **Stable session id format** — `sess_<epochMs>_<rand6>`. Chosen now so Phase B's per-session-folder migration doesn't orphan historical rows.
- **`src/server/dashboard-intelligence.ts` (NEW)** — pure-SQL aggregations:
  - `sessionsCount(window)` — `COUNT(DISTINCT session_id)` of assistant rows.
  - `tokenTotals(window)` — `SUM(tokens_in)`, `SUM(tokens_out)`, `SUM(cache_read)`.
  - `apiCallsCount(window)` — count of assistant rows. Documented semantics: "assistant turns completed", not provider HTTP requests.
  - `topModels(window, limit)` — `GROUP BY model` with token sum, distinct sessions, sum cost.
  - `cacheContribution(window)` — `cache_read / (cache_read + cache_write + tokens_in_uncached)`. Widget labeled **"Cache contribution"**, not "hit rate", because Anthropic's cache mechanic blurs that distinction.
  - `usageTrend(window, bucket='day')` — daily token totals + per-day top tool/skill.
  - `sessionsIntelligence(limit)` — per-session aggregates: msg count, tool count, token total, predominant model, time-ago, auto-summary tags. Tags are explicit constants in the file: `STALE = no activity in last 48h AND last_activity older than 7d`, `TOOL_HEAVY = tool_count > 20`, `HIGH_TOKEN = total_tokens > 100_000`. Auto-summary title = first user message truncated to 60 chars.
  - `hourOfDayHistogram(window)` — `GROUP BY strftime('%H', created_at)`. UTC; widget labels "UTC" so timezone shifts don't surprise.
  - `tokenMix(window)` — input / output / cache_read / cache_write breakdown (no `reasoning` until pi exposes it as a separate field).
  - `topTools(window, limit)` — `GROUP BY tool_name`. Widget labeled **"Tools Usage"** rather than "Skills Usage" because `tool.call.start.name` is the only signal pi gives us today; skill names that match tool names will surface, system-prompt-only skills won't (this is honest).
- **`GET /api/dashboard/intelligence?window=7d|14d|30d`** — single endpoint returning the union of the above. Window param clamped to `[1, 90]` days; 400 on out-of-range.
- **Shared TypeScript contract** — `src/types/dashboard.ts` typed shape used by both server (response builder) and client (consumer).
- **Frontend dashboard rebuild** — replace 8 stat cards + cost panel with the 7 Hermes-shaped widgets. Recharts (~90KB gz) for the line chart, hour histogram, and stacked bar. Hand-rolled SVG for sparklines + ranked bars.

## Scope

**In scope**
- Step 0: pi-event-mapper preserves usage on assistant + agent end events.
- Step 0.5: empirical investigation of how pi surfaces skills in its event stream. Outcome: Tools Usage widget keeps the data we know we have.
- Migration 003 + capture subscriber + idempotency + indexes.
- Stable session_id format (`sess_<epochMs>_<rand6>`).
- 9 aggregation functions + endpoint with window clamp.
- 7 dashboard widgets, Recharts where it makes sense.
- Tests: dashboard-intelligence.test.mjs unit tests with seeded chat_messages; chat-persister.test.mjs idempotency + failure-path; e2e for /api/dashboard/intelligence shape + dashboard renders.

**Out of scope**
- Phase B (per-session folders) — separate change.
- Phase C (agent-scoped sub-trees inside sessions) — separate change.
- LLM-generated session titles. v1 uses first-user-message-truncated.
- Tool-call rows in their own table (Phase B refactor candidate, S1 from review).
- Provider HTTP-request count separate from "assistant turns completed".
- Reasoning-tokens column. Pi may expose this later; we'll add via additive migration.

## Impact

- Affected specs: `session-intelligence` (new).
- Affected backend code: `src/events/pi-event-mapper.ts` (preserve usage), `src/server/db-migrations/003_session_intelligence.sql` (new), `src/server/chat-persister.ts` (new), `src/server/dashboard-intelligence.ts` (new), `src/routes/dashboard-intelligence.ts` (new), `src/server.ts` (route + persister wiring), `src/types/dashboard.ts` (new).
- Affected frontend code: `web/src/components/screens/DashboardScreen.tsx` (replaced), new `web/src/components/dash/` directory with one file per widget, `web/src/lib/api.ts` (new typed client), `web/package.json` (+ recharts).
- Tests: `tests/chat-persister.test.mjs` + `tests/dashboard-intelligence.test.mjs` + `web/test/e2e/session-intelligence.spec.ts`.
- Risk: medium. Persister race conditions and the mapper preservation are both load-bearing. Mitigations: persister uses ON CONFLICT idempotency; mapper change covered by an explicit unit test asserting `data.usage` survives.
