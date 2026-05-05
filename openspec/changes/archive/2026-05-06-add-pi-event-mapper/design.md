# Design: Pi Event Mapper

## Approach

A pure, synchronous TypeScript module exposing one function:

```ts
mapPiEvent(piEvent: unknown, state: MapperState, ctx: MapperContext): MapperResult
```

No classes, no module-level state, no async. The function is the unit of test, and fixtures recorded from real `pi --mode json` output are the unit of evidence.

The mapper does not assign `seq` or `eventId`. Those are the responsibility of the run-store / bus in Stage 2, where ordering is centralized and persistence is the source of truth. Keeping the mapper free of monotonic counters keeps it pure and per-event.

The mapper does not generate `turnId` or `messageId` itself either — it asks the caller via `ctx.nextTurnId()` and `ctx.nextMessageId()`. Tests inject deterministic counter-based factories; production injects `crypto.randomUUID()`. Real pi `agent_start` carries no prompt, so the workspace supplies it through `ctx.prompt`. These three caller-supplied entry points are the only seams where non-determinism enters the mapper, and they are explicit.

## Architecture

```
                                  ctx: { runId, sessionKey, prompt,
                                         nextTurnId(), nextMessageId() }
                                                |
                                                v
raw pi event (unknown) ─────► [ mapPiEvent ] ─────► { events: NormalizedEvent[],
state: { currentTurnId,                                 state: MapperState }
         currentMessageId } ───┘                    (zero, one, or many events)
```

### Types

```ts
// Workspace-side normalized event taxonomy (locked spec §2.1).
interface NormalizedEvent {
  event: string;
  data: Record<string, unknown>;
}

interface MapperContext {
  runId: string;
  sessionKey: string;
  // Real pi `agent_start` carries no prompt; the workspace supplies it.
  prompt?: string;
  nextTurnId(): string;
  // Real pi AssistantMessage has no `id`, so the mapper allocates one
  // on `message_start role=assistant`.
  nextMessageId(): string;
}

interface MapperState {
  currentTurnId: string | null;
  // Allocated on `message_start role=assistant`, cleared on
  // `message_end role=assistant`. Reused by streaming sub-events.
  currentMessageId: string | null;
}

interface MapperResult {
  events: NormalizedEvent[];
  state: MapperState;
}
```

### Dispatch shape

A single `switch (piEvent.type)`. Each branch is either a small inline literal or a tiny helper. `message_update` does a nested `switch (piEvent.assistantMessageEvent.type)` with both spellings (`toolcall_*` / `tool_call_*`) collapsed to the same case.

State updates are returned, never mutated. Either the input state is returned unchanged, or a new object is constructed. We intentionally do not use `Object.freeze` — the contract is enforced by tests, not runtime guards.

### Shape tolerance helpers

Three helpers absorb pi's wire-format variations so the dispatch logic stays readable:

- `contentToText(content)` — flattens an array of content blocks (`[{type:"text",text}, {type:"image",...}, ...]`) to a single string by concatenating `text` fields. Strings pass through unchanged for older spike fixtures.
- `extractToolCall(sub)` — pulls `toolCallId`, `name`, `argsDelta`, `args` from whichever location pi populated. For `toolcall_start` and `toolcall_delta` the info lives under `sub.partial.content[sub.contentIndex]`; for `toolcall_end` it lives under `sub.toolCall`. The older spike fixtures used flat `sub.toolCallId / .name / .argsDelta / .args`. The helper tries flat-shape fields first (cheapest read), then falls back to the nested `sub.toolCall` / `sub.partial.content[contentIndex]` block — both forms produce structurally identical normalized output.
- `passthroughPartial(piEvent)` — for `tool_execution_update`, prefers real-pi `partialResult` (a structured `{content, details}` object) over the older spike `partial` (a string), and forwards whichever exists unchanged so the UI can render it.

## Data model

No persistence. No new files in `~/.pi-workspace/`.

The TypeBox schemas of pi events themselves live in pi (`@mariozechner/pi-coding-agent`). We deliberately do NOT import them — the mapper accepts `unknown` and narrows defensively. Reasons:

1. Pi's exported types are still in flux; pinning to them would couple our test fixtures to upstream changes.
2. We must accept both spellings (`toolcall_*` and `tool_call_*`) — pi's current type only declares one.
3. Forward-compatibility: unknown event types must produce an empty array, not a type error.

## Decisions

- **Decision:** Mapper is pure; ctx supplies `prompt`, `nextTurnId()`, `nextMessageId()`.
  **Alternatives:** mapper holds counters; mapper returns ids and caller persists them; caller pre-allocates ids.
  **Why:** purity makes tests trivial (record fixture once, replay forever). The counter alternative leaks state into a module that should be replayable. Pre-allocation forces the caller to peek inside pi events to know when to allocate, which defeats the abstraction. The three caller-supplied seams are the minimum surface needed because real pi (a) doesn't include the prompt on `agent_start`, (b) doesn't include `id` on assistant messages, and (c) emits turn boundaries without ids.

- **Decision:** State is threaded explicitly (`state` in, `state` out), not mutated.
  **Alternatives:** mutable `state` object passed in; closure-captured state.
  **Why:** explicit state lets the test driver snapshot intermediate states and assert on them. Mutation makes "what was the state at line 5 of this fixture?" untestable without instrumentation.

- **Decision:** State is reset on both `agent_start` and `agent_end`.
  **Alternatives:** rely on `turn_end` / `message_end` to clear state.
  **Why:** abort and error flows skip the matching close events. Without a reset on the run boundary, a stale `currentTurnId` or `currentMessageId` would leak into the next run when the workspace reuses a pi process. The reset is cheap and bounds the failure mode.

- **Decision:** Output type is an array of zero-or-more events, not `event | null`.
  **Alternatives:** return single event or null; throw on no-op.
  **Why:** 99% of cases produce one event, but several produce zero (`text_start`, unknown type, malformed input, `session`), and a future case may produce multiple. Array-of-N normalizes the call site in Stage 2 to a single `for` loop.

- **Decision:** Both `toolcall_*` and `tool_call_*` spellings collapse to the same output, AND both real-pi nested layout and flat spike layout are supported simultaneously.
  **Alternatives:** accept only the new spelling; warn on the old; reject the old.
  **Why:** real pi v0.73 traces use `toolcall_*` with nested `partial.content[contentIndex]`. Older spike fixtures used `tool_call_*` with flat fields. The mapper is the layer where format drift is absorbed; everything downstream sees one shape.

- **Decision:** Unknown event types and malformed input return empty events, never throw.
  **Alternatives:** throw on unknown; log a warning; surface an internal `pi.error`.
  **Why:** the mapper runs hot in the bridge. Throwing kills the run for a benign new pi event. Logging is a side effect (caller's job — Stage 2 will log via the bus). An internal `pi.error` would conflate translation failure with pi-side errors.

- **Decision:** No imports from pi packages.
  **Alternatives:** import pi's TypeBox schemas and validate.
  **Why:** see "Data model" above. We pay a small price (manual narrowing) for a large gain (no upstream coupling for a hackathon).

- **Decision:** `agent_end` inspects the last message's `stopReason` to decide run status.
  **Alternatives:** always emit `success` and let Stage 2's run-store flip status on abort signals.
  **Why:** pi sometimes signals failure/abort only through a synthetic last assistant message in `agent_end.messages`, with `stopReason: "aborted" | "error"` and `errorMessage` (see `ai-projects/pi-mono/packages/agent/src/agent.ts:463`). Catching it here keeps the contract `agent_end → run.completed` complete instead of forcing the run-store to second-guess.

## Affected files & packages

- `src/events/pi-event-mapper.ts` — the function.
- `src/events/types.ts` — `MapperContext`, `MapperState`, `MapperResult`, `NormalizedEvent`, `INITIAL_STATE`.
- `src/events/index.ts` — barrel re-export.
- `tests/pi-event-mapper.test.mjs` — fixture-driven `node:test` runner; also runs full-sequence snapshot comparisons against the captured real-pi traces.
- `tests/fixtures/pi-event-mapper/<scenario>.in.jsonl` — raw pi events, one per line.
- `tests/fixtures/pi-event-mapper/<scenario>.out.jsonl` — expected normalized events (one array per input line).
- `tests/fixtures/pi-event-mapper/<scenario>.note.md` — one-paragraph "why" annotation per scenario, included in the human review bundle.
- `tests/fixtures/pi-event-mapper/real-pi/pi-json-{hello,tool}.jsonl` — verbatim `pi --mode json` output captured on the dev VM.
- `tests/fixtures/pi-event-mapper/real-pi/pi-json-{hello,tool}.expected.jsonl` — committed snapshot of the mapper's full normalized-event output for those traces.
- `gen-snapshots.mjs` (repo root) — regenerates the `.expected.jsonl` files after a deliberate mapper change. Workflow: run, review the diff, commit.

## Risks & mitigations

- **Risk:** Pi adds a new sub-event spelling we miss.
  **Mitigation:** `default` branch in inner switch returns empty; Stage 2 will log unknown-event counts. Adding a new mapping is a one-line change here plus a fixture.
- **Risk:** A real pi event has a field we don't pass through.
  **Mitigation:** fixtures are taken from real `pi --mode json` traces, not invented. The two snapshot tests fail loudly if the mapper changes its output for the captured traces.
- **Risk:** Test fixtures drift from real pi output silently.
  **Mitigation:** Stage 2's first run will spawn pi and capture live traces; we diff those against the Stage 1 snapshots and any drift is a review item before Stage 2 archives.
