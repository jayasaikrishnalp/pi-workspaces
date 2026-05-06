# Design: Session Intelligence

## Approach

Pi already emits everything we need. The fix is a one-character mapper change (preserve a field) plus a small persistence subscriber and a single read endpoint. The hard part is getting the widget set right and keeping the SQL fast as `chat_messages` grows.

Capture happens once on the bus, never in the bridge. The bridge stays a passthrough; one new subscriber is the single writer. Reads are pure SQL over the indexed table — no in-memory cache, no eventual consistency.

The Phase B/C deferrals are intentional. We freeze a stable `session_id` format now (`sess_<epochMs>_<rand6>`) so the future per-session-folder migration doesn't orphan historical rows. Everything else stays in-memory + on-disk as today.

## Architecture

```
pi (subprocess)
  └── stdout (rpc events) ───────────────────────────
                                                     │
       pi-rpc-bridge.ts                              │
       └── parses raw event ──────────────────────────────────────
                                                                  │
       pi-event-mapper.ts                                          │
       └── normalizes; PRESERVES usage.cost.* ────────────────────────
                                                                     │
       chat-event-bus.ChatEventBus.emit(EnrichedEvent)               │
                                                                     │
       ┌─── chat-events SSE consumer (existing)                      │
       │     └── frontend useChatStream                              │
       │                                                             │
       └─── chat-persister.ts (NEW, single subscriber)               │
             └── INSERT INTO chat_messages ON CONFLICT DO NOTHING    │
                  ↓                                                   │
            ┌─────────────────────────────────────┐                  │
            │ chat_messages (SQLite)               │                  │
            │  + tokens_in/out, cache_read/write   │                  │
            │  + cost_usd, model, provider, etc.   │                  │
            └─────────────────────────────────────┘                  │
                                                                      │
       dashboard-intelligence.ts (read-only aggregations)             │
            └── GET /api/dashboard/intelligence?window=…──────────────┘
                                                                      ↓
                                                          DashboardScreen
                                                          (7 widgets, Recharts)
```

## Data model — migration 003

```sql
ALTER TABLE chat_messages ADD COLUMN tokens_in   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN tokens_out  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN cache_read  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN cost_usd    REAL    NOT NULL DEFAULT 0;
ALTER TABLE chat_messages ADD COLUMN model       TEXT;          -- nullable: tool/user rows
ALTER TABLE chat_messages ADD COLUMN provider    TEXT;
ALTER TABLE chat_messages ADD COLUMN api         TEXT;
ALTER TABLE chat_messages ADD COLUMN response_id TEXT;
ALTER TABLE chat_messages ADD COLUMN duration_ms INTEGER;

CREATE TABLE IF NOT EXISTS session_titles (
  session_id TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  set_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created         ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_model           ON chat_messages(model)     WHERE model     IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_messages_tool            ON chat_messages(tool_name) WHERE tool_name IS NOT NULL;
```

Title goes in its own table so a future LLM-titler can backfill without touching message rows.

## Decisions

- **Capture in a bus subscriber, not the bridge.** R2 from the codex review. Single source of truth; `INSERT ... ON CONFLICT(id) DO NOTHING` makes retries safe.
- **Pi-event-mapper preserves `usage` instead of wrapping it in a new event.** Keeps the spec narrow. Existing event names + payloads stay the same; consumers get a new optional field.
- **Cache contribution, not hit rate.** R6 from the review. Anthropic's `cache_read` and `cache_creation` are both billed as input. We compute `cache_read / (cache_read + cache_write + tokens_in)` and label honestly.
- **Tools Usage, not Skills Usage.** R5. `tool.call.start.name` is the only skill-shaped signal pi gives us today; system-prompt-only skills are invisible in the event stream. Calling the widget "Tools Usage" is honest. If pi later surfaces a `skill.activated` event, we can add a separate Skills widget then.
- **`session_id` format fixed at `sess_<epochMs>_<rand6>`.** S2. When sessions become folders in Phase B, the current ids stay valid as folder names; the migration will add `session_path TEXT` referencing the disk location. No data loss.
- **Recharts for charts.** S6. ~90KB gz, composable, sensible defaults, stable API. Hand-rolled SVG for sparklines + ranked bars (10 lines of JSX, no dep).
- **Single endpoint returning everything for the window.** Three reads in three round trips would let widgets render at different times and look broken. One endpoint, one render.
- **Window param clamped to `[1, 90]` days.** Beyond 90 the table-scan cost stops being interesting on commodity hardware. Clamp emits `400 INVALID_WINDOW` with the allowed range.
- **No in-memory cache on the read path.** SQLite + the indexes is fast enough at the scale we ship at. We add caching when we have evidence of a problem, not before.

## Skill signal investigation (Step 0.5)

Empirically run a chat that exercises a known skill on the VM, capture pi's full event stream, classify which event types carry skill information.

Three possible outcomes:
1. `skill.activated` events exist → use them. Add a `skills_used TEXT` column (JSON array) on `chat_messages` and a Skills Usage widget.
2. Skills always come through as `tool.call.start` with names matching `<kbRoot>/skills/<name>` → use that. Tools Usage doubles as Skills Usage.
3. Skills are loaded as system-prompt context only → drop the Skills widget. Ship Tools Usage as the closest honest signal.

We document the outcome before writing the migration; the column set may shrink.

## Affected files

- New: `src/server/db-migrations/003_session_intelligence.sql`, `src/server/chat-persister.ts`, `src/server/dashboard-intelligence.ts`, `src/routes/dashboard-intelligence.ts`, `src/types/dashboard.ts`.
- Modified: `src/events/pi-event-mapper.ts` (preserve usage), `src/server.ts` (register route + start persister), `src/server/wiring.ts` (instantiate persister).
- New tests: `tests/chat-persister.test.mjs`, `tests/dashboard-intelligence.test.mjs`.
- Frontend: `web/src/components/screens/DashboardScreen.tsx` (rewritten), `web/src/components/dash/{HeroStats, UsageTrend, TopModels, CacheContribution, SessionsIntelligence, MixRhythm, ToolsUsage}.tsx` (new), `web/src/lib/api.ts` (+ typed client), `web/package.json` (+ recharts), `web/test/e2e/session-intelligence.spec.ts` (new).

## Risks & mitigations

- **Persister race with bus emit.** → `INSERT ... ON CONFLICT(id) DO NOTHING` plus the persister never throws upward; it logs.
- **Mapper preservation regressed by future event-shape change.** → Unit test asserts `data.usage` survives normalization for `message_end` + `agent_end`.
- **`session_id` collisions across restarts.** → Format includes `epochMs` so even rapid restarts get distinct prefixes; the `_rand6` suffix gives 36⁶ ≈ 2B values per ms.
- **Recharts pulls in a runtime dependency.** → Audited bundle delta. ~90KB gz acceptable; alternative would be ~200 lines of D3 hand-coding.
- **Tools-Usage-vs-Skills-Usage labeling confusion.** → Widget header reads "Tools Usage" with a tooltip explaining the difference. If pi adds a skill event later, a separate widget lands then.
- **Window clamp surprises operator.** → 400 INVALID_WINDOW with the allowed range and a hint to use 90d.
