# Events Spec

## Purpose

Owns the pure translation contract from pi-rpc events to the workspace's normalized SSE event taxonomy (locked spec §2.1). One stateless function (with caller-threaded state) absorbs every shape variation pi has shipped or might ship — both spike-era flat layouts and real pi v0.73 nested layouts — so that the bridge in higher stages sees exactly one event vocabulary regardless of pi version drift.

## Requirements

### Requirement: Deterministic Pure Translation

The system SHALL provide a pure mapper function that translates a raw pi-rpc event into zero or more normalized workspace events. The function MUST NOT perform I/O, read clocks, or generate random values internally. All non-determinism MUST be supplied through a context argument controlled by the caller, specifically: the caller-supplied `nextTurnId()`, the caller-supplied `nextMessageId()`, and the caller-supplied `prompt`. The mapper MUST NOT read pi process or filesystem state, and MUST treat `state` as immutable input that it returns alongside its events.

#### Scenario: Same input produces the same output

- **GIVEN** a raw pi event `e`, a state `s`, and a context `c` whose `nextTurnId()` and `nextMessageId()` are deterministic
- **WHEN** the mapper is invoked twice as `mapPiEvent(e, s, c)` with structurally equal arguments
- **THEN** both invocations return structurally equal `events` arrays
- **AND** both invocations return structurally equal `state` objects

#### Scenario: Mapper performs no I/O

- **GIVEN** the mapper module is loaded
- **WHEN** the mapper is invoked
- **THEN** no filesystem, network, child-process, or `process.stdout` activity is observable
- **AND** the only side-effect-shaped calls permitted are `ctx.nextTurnId()` and `ctx.nextMessageId()`, which the caller supplies

### Requirement: Run Lifecycle Translation

The system SHALL translate pi run-lifecycle events into the workspace's run lifecycle. Real pi `agent_start` carries no fields beyond `type`, so the workspace prompt is taken from `ctx.prompt`. Real pi `agent_end` carries `messages: AgentMessage[]`; the mapper inspects the last message's `stopReason` to decide the run status.

#### Scenario: agent_start emits run.start with prompt from context

- **GIVEN** a pi event `{type: "agent_start"}` and a context with `runId="r1"`, `sessionKey="s1"`, `prompt="hi"`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="run.start"` and `data={runId:"r1", sessionKey:"s1", prompt:"hi"}`
- **AND** the output `state` is `{currentTurnId: null, currentMessageId: null}`

#### Scenario: agent_end with no messages emits run.completed status=success

- **GIVEN** a pi event `{type: "agent_end", messages: []}` and a context with `runId="r1"`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="run.completed"` and `data={runId:"r1", status:"success"}`

#### Scenario: agent_end with stopReason="aborted" emits run.completed status=cancelled

- **GIVEN** a pi event `{type:"agent_end", messages:[{role:"assistant", stopReason:"aborted", errorMessage:"user requested abort", ...}]}` and a context with `runId="r1"`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="run.completed"` and `data={runId:"r1", status:"cancelled", error:"user requested abort"}`

#### Scenario: agent_end with stopReason="error" emits run.completed status=error

- **GIVEN** a pi event `{type:"agent_end", messages:[{role:"assistant", stopReason:"error", errorMessage:"upstream provider 503", ...}]}` and a context with `runId="r1"`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="run.completed"` and `data={runId:"r1", status:"error", error:"upstream provider 503"}`

### Requirement: Turn Allocation

The system SHALL allocate a fresh turn id on every pi `turn_start` event by calling `ctx.nextTurnId()`, and reuse that id for all message and tool events emitted within the turn until the matching `turn_end`.

#### Scenario: turn_start allocates a new turn id and updates state

- **GIVEN** a pi event `{type: "turn_start"}`, a state `{currentTurnId: null, currentMessageId: null}`, and a context whose `nextTurnId()` returns `"t-1"`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains an entry with `event="turn.start"` and `data.turnId="t-1"`
- **AND** the output `state.currentTurnId` is `"t-1"`

#### Scenario: turn_end clears currentTurnId

- **GIVEN** a state `{currentTurnId: "t-1", currentMessageId: null}` and a pi event `{type: "turn_end"}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains an entry with `event="turn.end"` and `data.turnId="t-1"`
- **AND** the output `state.currentTurnId` is `null`

### Requirement: State Reset On Run Boundaries

The system SHALL reset `state.currentTurnId` and `state.currentMessageId` to `null` on `agent_start` and `agent_end`, regardless of whether matching `turn_end` / `message_end` events were observed. This prevents a prior run's stale ids from leaking into the next run when pi is reused or a run is aborted mid-turn.

#### Scenario: agent_start resets stale state

- **GIVEN** a stale state `{currentTurnId: "t-prev", currentMessageId: "m-prev"}`
- **WHEN** the mapper is invoked with `{type: "agent_start"}`
- **THEN** the output `state` is `{currentTurnId: null, currentMessageId: null}`

#### Scenario: agent_end resets state from an aborted run

- **GIVEN** a dirty state `{currentTurnId: "t-1", currentMessageId: "m-1"}` (no turn_end / message_end ever observed)
- **WHEN** the mapper is invoked with `{type: "agent_end", messages: []}`
- **THEN** the output `state` is `{currentTurnId: null, currentMessageId: null}`

### Requirement: Message Id Allocation

The system SHALL allocate a fresh `messageId` via `ctx.nextMessageId()` on every `message_start role=assistant` because real pi `AssistantMessage` carries no `id` field. The allocated id MUST be stored on `state.currentMessageId` for the duration of the assistant message and reused by all `message_update` sub-events and the matching `message_end role=assistant`. The id MUST be cleared from state on `message_end role=assistant`.

#### Scenario: assistant message_start allocates and stores messageId

- **GIVEN** a pi event `{type: "message_start", message: {role: "assistant", content: []}}`, a state `{currentTurnId: "t-1", currentMessageId: null}`, and a context whose `nextMessageId()` returns `"m-1"`, with `runId="r1"`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="assistant.start"` and `data={runId:"r1", turnId:"t-1", messageId:"m-1"}`
- **AND** the output `state.currentMessageId` is `"m-1"`

#### Scenario: text_delta inherits messageId from state

- **GIVEN** a pi event `{type: "message_update", assistantMessageEvent: {type: "text_delta", contentIndex: 0, delta: "Hel"}}` and a state `{currentTurnId: "t-1", currentMessageId: "m-1"}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="assistant.delta"` and `data={runId:"r1", turnId:"t-1", messageId:"m-1", delta:"Hel"}`

#### Scenario: assistant message_end clears currentMessageId

- **GIVEN** a pi event `{type: "message_end", message: {role: "assistant", content: [{type: "text", text: "Hello"}], usage: {input: 100, output: 2}}}` and a state `{currentTurnId: "t-1", currentMessageId: "m-1"}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="assistant.completed"` and `data={runId:"r1", turnId:"t-1", messageId:"m-1", content:"Hello", usage:{input:100,output:2}}`
- **AND** the output `state.currentMessageId` is `null`

### Requirement: Message Lifecycle Translation

The system SHALL translate `message_start` and `message_end` events differently based on the message role.

#### Scenario: user message_start emits no events

- **GIVEN** a pi event `{type: "message_start", message: {role: "user", content: [{type:"text", text:"hi"}]}}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array is empty (the `message_end` carries the final content)

#### Scenario: toolResult message_start emits no events

- **GIVEN** a pi event `{type: "message_start", message: {role: "toolResult"}}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array is empty

#### Scenario: user message_end emits user.message with flattened content

- **GIVEN** a pi event `{type: "message_end", message: {role: "user", content: [{type:"text", text:"hi"}]}}` and a context with `runId="r1"`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="user.message"` and `data={runId:"r1", content:"hi"}`

#### Scenario: toolResult message_end emits tool.result

- **GIVEN** a pi event `{type:"message_end", message:{role:"toolResult", toolCallId:"toolu_1", toolName:"bash", content:[{type:"text", text:"ok"}], isError:false}}` and a state `{currentTurnId: "t-1", currentMessageId: null}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="tool.result"` and `data={runId:"r1", turnId:"t-1", toolCallId:"toolu_1", content:"ok"}`

### Requirement: Content Flattening

The system SHALL flatten pi `content` (which is always an array of content blocks like `[{type:"text", text:"..."}]`) to a single text string by concatenating the `text` fields of `type:"text"` blocks. Non-text blocks (image, thinking) are dropped from the flattened text. Plain strings are accepted unchanged for backward compatibility with older spike fixtures.

#### Scenario: content array with multiple text blocks concatenates

- **GIVEN** a pi event `{type:"message_end", message:{role:"user", content:[{type:"text",text:"part1 "},{type:"text",text:"part2"}]}}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains an entry with `data.content="part1 part2"`

#### Scenario: image block is dropped from flattened content

- **GIVEN** a pi event `{type:"message_end", message:{role:"user", content:[{type:"text",text:"caption"},{type:"image", data:"...", mimeType:"image/png"}]}}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains an entry with `data.content="caption"` (the image block is intentionally dropped at this layer)

### Requirement: Streaming Sub-Event Translation

The system SHALL translate `message_update` events by inspecting the `assistantMessageEvent.type` discriminator and producing the corresponding streaming event. The `messageId` for these events comes from `state.currentMessageId` (allocated at `message_start role=assistant`); real pi `message_update` carries no top-level `messageId`.

#### Scenario: text_delta emits assistant.delta

- **GIVEN** a pi event `{type:"message_update", assistantMessageEvent:{type:"text_delta", contentIndex:0, delta:"Hel"}}` and a state `{currentTurnId:"t-1", currentMessageId:"m-1"}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="assistant.delta"` and `data={runId:"r1", turnId:"t-1", messageId:"m-1", delta:"Hel"}`

#### Scenario: thinking_start, thinking_delta, thinking_end emit thinking events

- **GIVEN** pi events of sub-types `thinking_start`, `thinking_delta` (with `delta`), and `thinking_end`
- **WHEN** each is mapped with `state.currentMessageId="m-1"` and `state.currentTurnId="t-1"`
- **THEN** outputs are `thinking.start`, `thinking.delta` (carrying `delta`), and `thinking.end` respectively, each carrying `runId`, `turnId`, `messageId="m-1"`

#### Scenario: text_start and text_end emit no events

- **GIVEN** a pi event `{type:"message_update", assistantMessageEvent:{type:"text_start", contentIndex:0, partial:{...}}}` (or `text_end`)
- **WHEN** the mapper is invoked
- **THEN** the output `events` array is empty

### Requirement: Tool Call Translation (Real Pi Shape)

The system SHALL translate tool-call sub-events emitted under `message_update`. Real pi v0.73 nests the tool call info under `assistantMessageEvent.partial.content[contentIndex]` for `toolcall_start` and `toolcall_delta`, and under `assistantMessageEvent.toolCall` for `toolcall_end`. The mapper MUST extract `toolCallId` and `name` from whichever location is populated, and MUST treat the per-event `delta` (real pi) as the streaming `argsDelta`.

#### Scenario: toolcall_start with nested partial.content emits tool.call.start

- **GIVEN** a pi event `{type:"message_update", assistantMessageEvent:{type:"toolcall_start", contentIndex:0, partial:{role:"assistant", content:[{type:"toolCall", id:"toolu_1", name:"bash", arguments:{}}]}}}` and a state `{currentTurnId:"t-1", currentMessageId:"m-1"}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="tool.call.start"` and `data={runId:"r1", turnId:"t-1", toolCallId:"toolu_1", name:"bash"}`

#### Scenario: toolcall_delta with sub.delta emits tool.call.delta

- **GIVEN** a pi event `{type:"message_update", assistantMessageEvent:{type:"toolcall_delta", contentIndex:0, delta:"\"cmd\":", partial:{...content:[{type:"toolCall", id:"toolu_1", ...}]}}}` and a state `{currentTurnId:"t-1", currentMessageId:"m-1"}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="tool.call.delta"` and `data={runId:"r1", turnId:"t-1", toolCallId:"toolu_1", argsDelta:"\"cmd\":"}`

#### Scenario: toolcall_end with direct toolCall emits tool.call.end

- **GIVEN** a pi event `{type:"message_update", assistantMessageEvent:{type:"toolcall_end", contentIndex:0, toolCall:{type:"toolCall", id:"toolu_1", name:"bash", arguments:{"command":"echo hi"}}}}` and a state `{currentTurnId:"t-1", currentMessageId:"m-1"}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="tool.call.end"` and `data={runId:"r1", turnId:"t-1", toolCallId:"toolu_1", name:"bash", args:{"command":"echo hi"}}`

### Requirement: Tool Call Spelling And Shape Tolerance (Legacy)

The system SHALL also accept the older spike-era flat layout — `assistantMessageEvent.toolCallId`, `.name`, `.argsDelta`, `.args` — and the underscore-spelled sub-event names `tool_call_start`, `tool_call_delta`, `tool_call_end`, producing structurally compatible normalized events. New pi versions and old spike traces MUST both round-trip through the mapper.

#### Scenario: tool_call_start (underscore) with flat fields maps to tool.call.start

- **GIVEN** a pi event `{type:"message_update", assistantMessageEvent:{type:"tool_call_start", toolCallId:"toolu_1", name:"bash"}}` and a state `{currentTurnId:"t-1", currentMessageId:"m-1"}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="tool.call.start"` and `data={runId:"r1", turnId:"t-1", toolCallId:"toolu_1", name:"bash"}`

### Requirement: Tool Execution Translation

The system SHALL translate the three tool-execution lifecycle events emitted directly by pi (not nested in `message_update`). Real pi uses `toolName`, `partialResult`, `isError`, `result`. Older spike fixtures used `name`, `partial`, `ok`, `error`. The mapper MUST accept both, and MUST invert `isError` to the workspace event's `ok` field.

#### Scenario: tool_execution_start maps to tool.exec.start

- **GIVEN** a pi event `{type:"tool_execution_start", toolCallId:"toolu_1", toolName:"bash", args:{command:"echo hi"}}` and a state `{currentTurnId:"t-1", currentMessageId:null}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="tool.exec.start"` and `data={runId:"r1", turnId:"t-1", toolCallId:"toolu_1", name:"bash"}`

#### Scenario: tool_execution_update passes through partialResult unchanged

- **GIVEN** a pi event `{type:"tool_execution_update", toolCallId:"toolu_1", toolName:"bash", partialResult:{content:[{type:"text", text:"hi\n"}], details:{}}}` and a state `{currentTurnId:"t-1", currentMessageId:null}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="tool.exec.update"` and `data={runId:"r1", turnId:"t-1", toolCallId:"toolu_1", partial:{content:[{type:"text",text:"hi\n"}], details:{}}}`

#### Scenario: tool_execution_end with isError=false emits ok=true and no error

- **GIVEN** a pi event `{type:"tool_execution_end", toolCallId:"toolu_1", toolName:"bash", isError:false, result:"hi"}` and a state `{currentTurnId:"t-1", currentMessageId:null}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="tool.exec.end"` and `data={runId:"r1", turnId:"t-1", toolCallId:"toolu_1", ok:true}` (no `error` field)

#### Scenario: tool_execution_end with isError=true emits ok=false with error from result

- **GIVEN** a pi event `{type:"tool_execution_end", toolCallId:"toolu_2", toolName:"bash", isError:true, result:"command failed: exit 1"}` and a state `{currentTurnId:"t-1", currentMessageId:null}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="tool.exec.end"` and `data={runId:"r1", turnId:"t-1", toolCallId:"toolu_2", ok:false, error:"command failed: exit 1"}`

### Requirement: Pass-Through Events

The system SHALL forward `model_change`, `thinking_level_change` / `thinking_level_changed`, and pi `error` events into the corresponding workspace events. The thinking-level event accepts both the live RPC name `thinking_level_changed` (past tense, with `level` field — emitted from `agent-session.ts`) and the older session-entry name `thinking_level_change` (present tense, with `thinkingLevel` field — used by the session manager). Both normalize to the workspace `thinking_level_change` event.

#### Scenario: model_change forwards model and provider

- **GIVEN** a pi event `{type:"model_change", modelId:"claude-sonnet-4.6", provider:"github-copilot"}` and a context with `runId="r1"`, `sessionKey="s1"`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="model_change"` and `data={runId:"r1", sessionKey:"s1", modelId:"claude-sonnet-4.6", provider:"github-copilot"}`

#### Scenario: thinking_level_changed (live RPC name) with level field forwards level

- **GIVEN** a pi event `{type:"thinking_level_changed", level:"high"}` and a context with `runId="r1"`, `sessionKey="s1"`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="thinking_level_change"` and `data={runId:"r1", sessionKey:"s1", level:"high"}`

#### Scenario: thinking_level_change (legacy name) with thinkingLevel field forwards level

- **GIVEN** a pi event `{type:"thinking_level_change", thinkingLevel:"medium"}` and a context with `runId="r1"`, `sessionKey="s1"`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="thinking_level_change"` and `data={runId:"r1", sessionKey:"s1", level:"medium"}`

#### Scenario: error event forwards code and message

- **GIVEN** a pi event `{type:"error", code:"X", message:"boom"}` and a context with `runId="r1"`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array contains exactly one entry with `event="pi.error"` and `data={runId:"r1", code:"X", message:"boom"}`

### Requirement: Pi Session Event Is Dropped

The system SHALL drop pi's `session` event (`{type:"session", version, id, timestamp, cwd}`), because the workspace's `session.start` is workspace-emitted (carries `model` + `thinkingLevel` from settings — fields pi's session event does not provide).

#### Scenario: pi session event maps to no events

- **GIVEN** a pi event `{type:"session", version:3, id:"abc", timestamp:"2026-05-05", cwd:"/home/x"}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array is empty
- **AND** the output `state` deep-equals the input state

### Requirement: Unknown Events Are Skipped

The system SHALL return an empty `events` array when given an event whose `type` is not recognized, leaving state unchanged.

#### Scenario: Unknown type returns empty events and unchanged state

- **GIVEN** a pi event `{type:"future_event_kind", foo:"bar"}` and a state `{currentTurnId:"t-1", currentMessageId:null}`
- **WHEN** the mapper is invoked
- **THEN** the output `events` array is empty
- **AND** the output `state` deep-equals the input state

### Requirement: Malformed Events Do Not Throw

The system SHALL handle events with missing or wrong-type discriminator fields by returning an empty `events` array; the mapper MUST NOT throw on malformed input.

#### Scenario: Event missing type returns empty

- **GIVEN** an input value `{}` (no `type` field) or `null` or a primitive
- **WHEN** the mapper is invoked
- **THEN** the output `events` array is empty
- **AND** the output `state` deep-equals the input state
- **AND** no exception is thrown
### Requirement: Chat Event Bus

The system SHALL provide a singleton in-process pub/sub bus that delivers enriched events to every subscriber that was attached at the moment of emit. Each enriched event MUST carry the original normalized event plus a `meta` object: `{runId, sessionKey, seq, eventId}`. The bus itself MUST NOT mutate `seq`/`eventId` — those are stamped by the run-store before emit.

#### Scenario: Subscribers attached before emit receive the event

- **GIVEN** the chat event bus has zero subscribers
- **WHEN** subscriber A attaches and the bus then emits an event
- **THEN** subscriber A's handler runs exactly once with the enriched event
- **AND** if subscriber B attaches AFTER that emit, B does not receive the past event

#### Scenario: Unsubscribe stops further deliveries

- **GIVEN** subscriber A is attached
- **WHEN** A's unsubscribe function is called and the bus then emits an event
- **THEN** A's handler is not invoked

### Requirement: Disk-Before-Bus Ordering

The system SHALL persist a normalized event to the run-store and update the run's `seq.txt` BEFORE emitting it to the chat event bus. A subscriber attached at any time MUST never receive an event that is not already on disk.

#### Scenario: An attached subscriber sees only events that are already persisted

- **GIVEN** a subscriber is attached and a run is in flight
- **WHEN** the subscriber receives an event with `meta.eventId === "<runId>:42"`
- **THEN** reading `events.jsonl` of `<runId>` at that moment returns at least 42 lines
- **AND** the line whose `meta.seq === 42` matches the delivered event byte-for-byte
