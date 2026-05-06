# Tasks: Session Intelligence

## 0. Step 0 — pi-event-mapper preserves usage

- [ ] 0.1 `src/events/pi-event-mapper.ts` — on `assistant.start` / `message_end` (assistant) / `agent_end` / `turn_end`, copy `message.usage` to `data.usage` verbatim.
- [ ] 0.2 `tests/pi-event-mapper.test.mjs` — extend with two cases asserting `data.usage` survives normalization for assistant message_end + that user-role message_end has no `data.usage` field.

## 0.5 Step 0.5 — Skill signal investigation (verify before migration)

- [ ] 0.5.1 On the VM, capture pi's full event stream while running a chat that exercises a known skill (e.g. `pi --print --mode json --skill <name> "..."`).
- [ ] 0.5.2 Classify which event type carries the skill activation: `skill.activated`, `tool.call.start`, system-prompt-only.
- [ ] 0.5.3 Document the outcome in this file. If skill activation is invisible in the event stream, drop "Skills Usage" and ship "Tools Usage" as the closest honest signal.

## 1. Migration 003 + stable session id

- [ ] 1.1 `src/server/db-migrations/003_session_intelligence.sql` — additive ALTER TABLE for `tokens_in/out, cache_read/write, cost_usd, model, provider, api, response_id, duration_ms`. All token columns `INTEGER NOT NULL DEFAULT 0`. `cost_usd REAL NOT NULL DEFAULT 0`. Nullable text columns. Add 4 indexes.
- [ ] 1.2 `src/server/db-migrations/003_session_intelligence.sql` — also creates the `session_titles` table.
- [ ] 1.3 `src/routes/sessions.ts` — `POST /api/sessions` returns `sessionKey = "sess_" + Date.now() + "_" + 6-char-rand`. Existing routes unchanged.
- [ ] 1.4 Migration runner test confirms migration 003 lands cleanly on a populated 002-state DB.

## 2. Capture subscriber

- [ ] 2.1 `src/server/chat-persister.ts` — `installPersister(bus, db)` returns `{stop}`. Subscribes to the chat-event-bus; on assistant `message_end` writes a row; on `tool.call.start` writes a tool-call row. Errors logged via `console.error("[persister]", ...)`, never thrown.
- [ ] 2.2 `src/server/wiring.ts` — start the persister when the workspace boots. Stop on shutdown.
- [ ] 2.3 `tests/chat-persister.test.mjs` — write happy-path; idempotency on duplicate id; persister-throws-but-bus-keeps-emitting.

## 3. Aggregations + endpoint

- [ ] 3.1 `src/types/dashboard.ts` — `DashboardIntelligence` interface for the response payload + per-widget sub-types.
- [ ] 3.2 `src/server/dashboard-intelligence.ts` — 9 query functions per the spec. Constants: `STALE_DAYS=7`, `STALE_INACTIVE_HOURS=48`, `TOOL_HEAVY_THRESHOLD=20`, `HIGH_TOKEN_THRESHOLD=100_000`.
- [ ] 3.3 `src/routes/dashboard-intelligence.ts` — handler reads `window` query param, validates `[1, 90]` range, calls aggregator, returns the typed payload. 400 INVALID_WINDOW on out-of-range.
- [ ] 3.4 Register route in `src/server.ts`.
- [ ] 3.5 `tests/dashboard-intelligence.test.mjs` — seed chat_messages with deterministic rows, assert each function returns the expected shape + values. Tag computation correctness.

## 4. Frontend dashboard

- [ ] 4.1 `web/package.json` — add `recharts@^2.12`.
- [ ] 4.2 `web/src/lib/api.ts` — `fetchIntelligence(window)` typed against the shared interface.
- [ ] 4.3 `web/src/components/dash/HeroStats.tsx` — 4 hero cards with hand-rolled-SVG sparklines.
- [ ] 4.4 `web/src/components/dash/UsageTrend.tsx` — Recharts LineChart with 7D/14D/30D toggle.
- [ ] 4.5 `web/src/components/dash/TopModels.tsx` — ranked list with bar visualization + per-model cost.
- [ ] 4.6 `web/src/components/dash/CacheContribution.tsx` — gauge / number card labeled "Cache contribution".
- [ ] 4.7 `web/src/components/dash/SessionsIntel.tsx` — scrollable list with tag pills.
- [ ] 4.8 `web/src/components/dash/MixRhythm.tsx` — Recharts stacked bar + hour-of-day Recharts BarChart.
- [ ] 4.9 `web/src/components/dash/ToolsUsage.tsx` — ranked bar list.
- [ ] 4.10 `web/src/components/screens/DashboardScreen.tsx` — rewritten to mount the seven widgets in the design's grid layout. Drop placeholder cost panel.
- [ ] 4.11 `web/src/styles/sidebar.css` — dashboard layout grid + widget chrome.
- [ ] 4.12 `web/test/e2e/session-intelligence.spec.ts` — assert each widget testid renders; window-selector swap; intelligence endpoint hit.

## 5. Verification + archive

- [ ] 5.1 Backend suite green (target: 254 + ~15 new = ~269).
- [ ] 5.2 Vitest + Playwright green (target: ~50 frontend tests).
- [ ] 5.3 Hand-test on the VM: send a chat through pi, watch the dashboard update.
- [ ] 5.4 Three commits + push (propose / implement / archive).
- [ ] 5.5 Codex review pass — defer to post-archive sweep with the next change.
