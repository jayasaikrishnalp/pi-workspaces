// Workspace-side normalized event taxonomy (locked spec §2.1).
// `data` shape varies per `event` name. Every run-scoped event carries `runId`;
// session-scoped events (model_change, thinking_level_change) also carry `sessionKey`.
// `seq` and `eventId` are NOT assigned here — the bus / run-store does that in Stage 2.
export interface NormalizedEvent {
  event: string
  data: Record<string, unknown>
}

export interface MapperContext {
  runId: string
  sessionKey: string
  // Real pi `agent_start` does NOT carry the prompt, so the workspace (which
  // received the prompt from the user via POST) supplies it here.
  prompt?: string
  // Caller-supplied source of fresh turn ids. Tests inject a deterministic counter;
  // production injects `crypto.randomUUID`.
  nextTurnId: () => string
  // Caller-supplied source of fresh message ids. Real pi `AssistantMessage`
  // does not carry an `id`, so the mapper allocates one on `message_start
  // role=assistant` and reuses it through `message_end`. Tests inject a counter.
  nextMessageId: () => string
}

export interface MapperState {
  currentTurnId: string | null
  // Allocated on `message_start role=assistant`, cleared on `message_end role=assistant`.
  // Reused for the streaming sub-events (`assistant.delta`, `thinking.*`) emitted
  // between start and end. tool.call.* events use the `toolCall.id` from the
  // pi event itself, not this field.
  currentMessageId: string | null
}

export interface MapperResult {
  events: NormalizedEvent[]
  state: MapperState
}

export const INITIAL_STATE: MapperState = Object.freeze({
  currentTurnId: null,
  currentMessageId: null,
})
