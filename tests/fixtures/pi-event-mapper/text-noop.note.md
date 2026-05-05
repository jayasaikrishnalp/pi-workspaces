# text-noop

`text_start` and `text_end` mark the boundaries of an assistant text block. The UI infers them from the delta stream, so the mapper drops both. Real pi `text_end` includes the full assembled `content` (e.g. `"Hello"`) — the mapper still drops it because `assistant.completed` is the canonical "final assistant text" event.
