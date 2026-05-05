# unknown-and-malformed

The mapper must NEVER throw. Each of these inputs yields an empty `events` array and unchanged state:

- a brand-new pi event type the mapper hasn't been taught
- an empty object (no `type` field)
- `null` itself
- a `message_update` missing its `assistantMessageEvent` block
- a `message_update` whose sub-event type is unknown

The "malformed inputs do not throw" test in `pi-event-mapper.test.mjs` covers a wider set (arrays, primitives, undefined). This fixture documents the behavior at the level of the spec scenarios.
