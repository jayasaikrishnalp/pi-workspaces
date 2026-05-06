# Proposal: Chat-Controls — Multi-Model Switching + Tool Approval Forwarding

## Why

The frontend rebuild needs two surfaces this change unlocks: (1) a Settings screen that switches the active provider/model live, and (2) a chat composer that surfaces pi's `extension_ui_request` events so the operator can approve/abort tool calls without leaving the workspace. Both depend on backend bridge wiring that wasn't shipped in `add-agents-workflows-memory-and-pi-probe` (see that change's Amendments section for the rationale of the split).

## What changes

- Bridge: `bridge.setModel({providerId, modelId})` and `bridge.cycleModel(direction)` send pi RPC commands and persist the choice via `ProvidersClient.setActive`.
- Bridge: stdout handler recognizes `extension_ui_request` lines, persists them through the run-store, and emits `pi.ui-request` events on the chat bus.
- Stage-1 mapper: `extension_ui_request` becomes `{event:"pi.ui-request", data:{runId, request}}` with a fixture pair + snapshot test.
- Routes: `POST /api/sessions/:sessionKey/model`, `POST /api/sessions/:sessionKey/model/cycle`, `POST /api/runs/:runId/ui-response`.
- ui-response gating: validates the request id is in flight, returns 400 UNKNOWN_UI_REQUEST or 409 RUN_FINISHED otherwise.

## Scope

**In scope**
- The `chat-controls` delta spec lifted verbatim from the prior change.
- Bridge + mapper + route changes.
- Tests covering set/cycle happy paths, validation errors, and ui-response gating.

**Out of scope**
- Frontend Settings screen + composer surfaces — those live in the frontend rebuild change.
- New providers beyond the eight already in `ProvidersClient`.

## Impact

- Affected specs: `chat-controls` (new).
- Affected code: `src/server/pi-rpc-bridge.ts`, `src/server/pi-event-mapper.ts`, new `src/routes/chat-controls.ts`, `src/server.ts` route table.
- Risk: medium. Touches the pi bridge stdout parser; regressions there break all chat events. Mitigation: pure-function mapper test + bridge integration test before merge.
