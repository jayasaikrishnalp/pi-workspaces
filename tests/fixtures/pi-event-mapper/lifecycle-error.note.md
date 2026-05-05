# lifecycle-error

Same shape as `lifecycle-aborted` but with `stopReason:"error"`. Mapper emits `run.completed {status:"error", error}`. Status values per locked spec §2.1: `success | cancelled | error`.
