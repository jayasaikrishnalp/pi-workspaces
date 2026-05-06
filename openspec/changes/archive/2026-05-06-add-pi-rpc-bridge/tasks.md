# Tasks: Pi-RPC Bridge + Bus + Run Store

## 1. Types and shared modules

- [x] 1.1 `src/types/run.ts` — `RunStatus`, `RunMeta`, `EnrichedEvent`, `BridgeContext`.
- [x] 1.2 `src/server/wiring.ts` — assembles bridge + bus + run-store + tracker as singletons (lazy).

## 2. Run-store

- [x] 2.1 `src/server/run-store.ts` — directory layout, `appendNormalized`, `getEvents`, `getStatus`, `casStatus`, per-run write chain.
- [x] 2.2 `tests/run-store.test.mjs` — unit tests: monotonic seq under concurrent appends, atomic status CAS, replay sorted by seq, missing run returns null.

## 3. Chat event bus

- [x] 3.1 `src/server/chat-event-bus.ts` — subscribe / unsubscribe / emit, singleton on globalThis.
- [x] 3.2 `tests/chat-event-bus.test.mjs` — unit tests: handlers run on emit, unsubscribe stops, late subscriber does not receive past events.

## 4. Send-run-tracker

- [x] 4.1 `src/server/send-run-tracker.ts` — `start`, `finish`, `getActive`. Synchronous slot lock per sessionKey.
- [x] 4.2 `tests/send-run-tracker.test.mjs` — unit: start twice on same session throws; finish clears.

## 5. Pi-RPC bridge

- [x] 5.1 `src/server/pi-rpc-bridge.ts` — spawn `pi --mode rpc` detached, stdin write queue, stdout line buffer + JSON parse, route events through Stage 1 mapper into the bus via run-store, restart-on-crash.
- [x] 5.2 Crash handling: on `child.exit`, clear bridge state; emit `pi.error` + `run.completed status:"error"` for the active run; clear tracker.
- [x] 5.3 Backoff for restart: 0s, 1s, 5s, 30s; reset on first successful response.

## 6. Routes

- [x] 6.1 `src/routes/sessions.ts` — `POST /api/sessions`, `GET /api/sessions`, `GET /api/sessions/:sessionKey/active-run`.
- [x] 6.2 `src/routes/send-stream.ts` — `POST /api/send-stream`, body validation, tracker check, bridge.send.
- [x] 6.3 `src/routes/chat-events.ts` — `GET /api/chat-events`, live SSE filtered by sessionKey.
- [x] 6.4 `src/routes/runs.ts` — `GET /api/runs/:runId/events?afterSeq=`, replay-aware SSE per spec §2.4.
- [x] 6.5 Wire all four routes into `src/server.ts`'s ROUTES table.

## 7. Integration tests against real pi

- [x] 7.1 `tests/integration/_pi-helpers.mjs` — `bootWorkspace()`, `createSession()`, `submitPrompt()`, `collectSse(url, untilEvent)`.
- [x] 7.2 `tests/integration/send-stream.smoke.mjs` — Scenario A: POST then SSE. Verify every event arrives, seq is 1..N strictly, `run.completed` is the last.
- [x] 7.3 `tests/integration/replay.smoke.mjs` — Scenario B: SSE then POST. Verify events still arrive in the same order. Both scenarios must reach identical final disk state.
- [x] 7.4 `tests/integration/active-run-dedup.smoke.mjs` — POST while running → 409 with structured body. POST after completion → 202.

## 8. Review + verification

- [x] 8.1 Every requirement scenario in pi-rpc / runs / sessions / events deltas backed by at least one test.
- [x] 8.2 Smoke + unit + integration suite green on the VM (no skipped tests on a happy path).
- [x] 8.3 Codex review iterated to clean.
- [x] 8.4 Markdown review bundle saved under `review/STAGE-2-...`.
- [x] 8.5 Three commits + push.
