# tool-call-spike-shape

Older spike traces (pre-v0.73 pi) used a flat layout with `toolCallId`, `name`, `argsDelta`, `args` directly on `assistantMessageEvent`. The mapper still accepts this shape so older fixture/replay traces continue to work — and so the underscore variants (`tool_call_*`) keep parsing. Both this scenario and `tool-call` produce structurally consistent output for their respective shapes.
