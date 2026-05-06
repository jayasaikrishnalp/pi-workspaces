# Tasks: Pi Event Mapper

## 1. Types and module skeleton

- [x] 1.1 Create `src/events/types.ts` with `NormalizedEvent`, `MapperContext`, `MapperState`, `MapperResult`, `INITIAL_STATE`.
- [x] 1.2 Create `src/events/pi-event-mapper.ts` exporting `mapPiEvent` with the full signature; default branch returns empty events and unchanged state.
- [x] 1.3 Create `src/events/index.ts` barrel re-export.

## 2. Lifecycle and turn translation

- [x] 2.1 Implement `agent_start → run.start` (prompt sourced from `ctx.prompt`, real pi sends none).
- [x] 2.2 Implement `agent_end → run.completed`; inspect `messages[-1].stopReason` to map "aborted"→cancelled, "error"→error, default→success.
- [x] 2.3 Implement `turn_start → turn.start` and update `state.currentTurnId` via `ctx.nextTurnId()`.
- [x] 2.4 Implement `turn_end → turn.end` and clear `state.currentTurnId`.
- [x] 2.5 Reset `state` (both ids → null) on `agent_start` and `agent_end`.

## 3. Message lifecycle

- [x] 3.1 Implement `message_start role=assistant → assistant.start`; allocate `messageId` via `ctx.nextMessageId()`, store on `state.currentMessageId`.
- [x] 3.2 Implement `message_start role=user → []` and `message_start role=toolResult → []`.
- [x] 3.3 Implement `message_end role=user → user.message` (content flattened).
- [x] 3.4 Implement `message_end role=assistant → assistant.completed`; clear `state.currentMessageId`.
- [x] 3.5 Implement `message_end role=toolResult → tool.result` (content flattened).

## 4. Streaming sub-events (message_update)

- [x] 4.1 Implement `text_delta → assistant.delta` (messageId from state).
- [x] 4.2 Implement `thinking_start → thinking.start`, `thinking_delta → thinking.delta`, `thinking_end → thinking.end`.
- [x] 4.3 Implement `text_start` and `text_end` returning `[]`.
- [x] 4.4 Implement tool-call sub-events with both spellings collapsed and both nested/flat layouts supported via `extractToolCall()`.

## 5. Tool execution and pass-through

- [x] 5.1 Implement `tool_execution_start/_update/_end → tool.exec.*` (real-pi `toolName`/`partialResult`/`isError` + spike `name`/`partial`/`ok`).
- [x] 5.2 Implement `model_change` and `thinking_level_change[d]` pass-through (both names + both field spellings).
- [x] 5.3 Implement `error → pi.error`.
- [x] 5.4 Implement `session → []` (workspace emits its own `session.start`).

## 6. Defensive narrowing

- [x] 6.1 Top-level guard: `null`/non-object/missing-`type` input returns empty events and unchanged state.
- [x] 6.2 `message_update` with missing `assistantMessageEvent` returns empty.
- [x] 6.3 Unknown `type` returns empty events and unchanged state.
- [x] 6.4 `contentToText()` handles strings, content arrays (text blocks concatenated, image/other blocks dropped), and empty arrays.

## 7. Fixtures and tests

- [x] 7.1 Capture real `pi --mode json` traces on the VM (hello + tool-using prompts) into `tests/fixtures/pi-event-mapper/real-pi/`.
- [x] 7.2 Create one fixture pair per requirement scenario: lifecycle, lifecycle-aborted, lifecycle-error, message-user, message-assistant, message-toolresult, thinking, tool-call (real-pi shape), tool-call-spike-shape (legacy compat), tool-exec, tool-exec-error, passthrough, session-event, text-noop, content-flattening, unknown-and-malformed.
- [x] 7.3 For each scenario produce `<scenario>.in.jsonl`, `<scenario>.out.jsonl`, `<scenario>.note.md`.
- [x] 7.4 Create `tests/pi-event-mapper.test.mjs` that walks every scenario, replays inputs through the mapper with deterministic counter-based `nextTurnId()` / `nextMessageId()`, and asserts deep-equal against the expected output.
- [x] 7.5 Add tool-call shape-tolerance test (real-pi nested vs spike flat produce structurally compatible output).
- [x] 7.6 Add full-sequence snapshot tests for both real-pi traces against `<trace>.expected.jsonl`.
- [x] 7.7 Add `gen-snapshots.mjs` at the repo root for regenerating snapshot files after deliberate mapper changes.
- [x] 7.8 Add `npm test` / `test:smoke` / `test:unit` scripts in `package.json` and ensure they run on the VM under `node --import tsx`.

## 8. Review and verification

- [x] 8.1 All scenarios in `events` delta have at least one fixture pair + test.
- [x] 8.2 Full smoke + unit suite green on the VM (35/35).
- [x] 8.3 Codex review round 1: 5 REQUIRED + 2 RECOMMENDED — all addressed (real-pi shape rewrite).
- [x] 8.4 Codex review round 2: 6 REQUIRED + 2 RECOMMENDED — all addressed (abort/error mapping, spec drift, full-sequence snapshots).
- [x] 8.5 Codex review round 3: 2 REQUIRED + 2 RECOMMENDED — all addressed (content-flattening fixture, design.md, gen-snapshots.mjs).
- [x] 8.6 Codex review round 4: REQUIRED=None, "ready to commit"; minor RECOMMENDED/NIT applied.
- [x] 8.7 Generate the markdown review bundle for user verification.
- [x] 8.8 **Wait for explicit user sign-off** before committing.
