# message-toolresult

Real pi tool-result messages carry `{role:"toolResult", toolCallId, toolName, content[blocks], isError, timestamp}`. The workspace `tool.result` event keeps only `{runId, turnId, toolCallId, content}` — `toolName` and `isError` are dropped because they are already known from the prior `tool.exec.start` / `tool.exec.end` events on the same `toolCallId`.

Shape from `real-pi/pi-json-tool.jsonl` line 18.
