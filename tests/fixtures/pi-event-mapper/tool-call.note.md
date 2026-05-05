# tool-call

Real pi tool-call sub-events from the captured `bash` invocation. The mapper has to pull `id` and `name` from two different places:

- `toolcall_start` and `toolcall_delta` carry the tool-call info under `assistantMessageEvent.partial.content[contentIndex]` as `{type:"toolCall", id, name, arguments, partialJson}`.
- `toolcall_end` carries it directly under `assistantMessageEvent.toolCall`.

`extractToolCall()` in the mapper resolves either layout. `argsDelta` reads from `sub.delta` (real pi) or `sub.argsDelta` (older spike).

Verbatim shape from `real-pi/pi-json-tool.jsonl` toolcall_start/delta/end events.
