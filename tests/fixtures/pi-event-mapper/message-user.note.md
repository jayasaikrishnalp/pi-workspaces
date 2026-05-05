# message-user

Real pi user messages carry `content` as an array of content blocks. The mapper flattens text blocks via `contentToText()`. `message_start role=user` is intentionally a no-op — the spec covers user content at end (since pi sends final content, no streaming).

Verbatim shape from `tests/fixtures/pi-event-mapper/real-pi/pi-json-hello.jsonl` line 4-5.
