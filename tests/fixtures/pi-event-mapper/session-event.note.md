# session-event

Real pi opens every `--mode json` session with a `session` event:
`{type:"session", version, id, timestamp, cwd}`. The workspace's
`session.start` is workspace-emitted (it carries `model` and
`thinkingLevel`, which pi's session event doesn't), so the mapper
intentionally drops pi's `session` event.
