# lifecycle-aborted

When pi's agent loop is aborted (user-requested cancellation), pi appends a synthetic assistant message with `stopReason:"aborted"` and `errorMessage`, then emits `agent_end {messages:[failureMessage]}`. The mapper inspects the last message and emits `run.completed {status:"cancelled", error}`.

Source: `ai-projects/pi-mono/packages/agent/src/agent.ts:463` (handleRunFailure).
