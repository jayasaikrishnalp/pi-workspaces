# tool-exec

Real pi tool-execution events from the captured `bash` invocation. Notable shape differences from the older spike:

- `toolName` (not `name`)
- `partialResult` is a structured `{content: [...], details: {}}` object — passed through unchanged so the UI can render it; previous spike traces used a plain string `partial`
- `isError` (not `ok`); the mapper inverts to `ok: !isError`
- Successful end has no `error` field on the output

Verbatim shape from `real-pi/pi-json-tool.jsonl` tool_execution_* events.
