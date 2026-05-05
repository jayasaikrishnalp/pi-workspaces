# message-assistant

Streams "Hello" two text chunks at a time. Real pi assistant messages have NO `id` field, so the mapper allocates one via `ctx.nextMessageId()` (yields `m-1`) on `message_start` and reuses it through the deltas and `message_end`. Streaming sub-events do not carry a top-level `messageId` either — they pick it up from `state.currentMessageId`.

Shape verified against `real-pi/pi-json-hello.jsonl` lines 6-12.
