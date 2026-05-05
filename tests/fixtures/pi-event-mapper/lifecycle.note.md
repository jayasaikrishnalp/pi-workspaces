# lifecycle

Real pi `agent_start` carries no fields beyond `type`. The user prompt is supplied by the workspace through `ctx.prompt` (the test harness sets `prompt: "hello"`). `agent_end` resets per-run state defensively.

| pi event | normalized event | why |
|---|---|---|
| `agent_start` | `run.start` | prompt comes from `ctx.prompt`, not pi |
| `turn_start` | `turn.start` | mapper allocates `turnId` via `ctx.nextTurnId()` |
| `turn_end` | `turn.end` | clears `state.currentTurnId` |
| `agent_end` | `run.completed` | success status; resets state |
