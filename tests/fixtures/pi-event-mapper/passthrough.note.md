# passthrough

`model_change`, `thinking_level_change*`, and `error` are forwarded with their payload fields preserved. The mapper accepts both the live RPC name `thinking_level_changed` (past tense, with `level` field — confirmed in pi v0.73 `agent-session.ts`) and the older synthetic `thinking_level_change` (present tense, with `thinkingLevel` field). Both normalize to the same workspace event.
