# Proposal: Pi Event Mapper

## Why

Stage 2 will spawn `pi --mode rpc` and stream its events to browsers as SSE. Pi's RPC event vocabulary (~25 distinct shapes across `agent_*`, `turn_*`, `message_*`, `tool_*`, `model_change`, etc.) does not match the workspace's normalized SSE taxonomy (24 chat events, defined in §2.1 of the locked spec). Pi also emits two competing spellings for tool calls — `toolcall_*` (current) and `tool_call_*` (older spike build). Mixing both forms in the same stream is real: spike1c traces had `tool_call_*`; spike5 traces had `toolcall_*`.

Wrapping this translation in HTTP code (Stage 2) without isolating it first is a recipe for unfixable regressions — every shape change in pi would force re-testing the entire bridge. We separate the translation into a **pure function** with fixture-driven tests so Stage 2 can rely on it as a black box.

This change introduces that pure module, its types, and the fixture pairs that anchor every mapping rule.

## What changes

- New `events` capability: a deterministic translation contract from pi-rpc events to the workspace SSE taxonomy.
- A pure mapper function `mapPiEvent(piEvent, state, ctx) → { events, state }` — no I/O, no clocks, no `Math.random`.
- Tolerance: both `toolcall_*` and `tool_call_*` spellings produce identical normalized events.
- Defined no-op behavior: roles and sub-events covered elsewhere (e.g., `message_start role=user`, `message_update text_start`) return an empty array — the mapper does not invent events.
- Unknown event types return an empty array (forward-compatibility with future pi versions).
- Fixture-driven tests: paired JSONL files of raw pi events + expected normalized output, replayed line-by-line.

## Scope

**In scope**
- The pure mapper function + its TypeScript types.
- One fixture pair per scenario, with an annotated event timeline so the user can verify each mapping rule visually.
- Unit tests under `tests/pi-event-mapper.test.mjs` driven entirely by fixtures.

**Out of scope**
- HTTP routing, SSE response writing, or pi process spawning (Stage 2).
- The `seq`/`eventId` stamp (assigned by the run-store / bus in Stage 2 — the mapper output carries `runId` only).
- Heartbeats, `connected`, and `run.cancelling` (synthetic events emitted by the server, not mapped from pi — Stage 2 / Stage 3).
- KB events (separate channel — Stage 4).

## Impact

- Affected specs: `events` (new domain).
- Affected code areas: `src/events/` (new module), `tests/pi-event-mapper.test.mjs` (new), `tests/fixtures/pi-event-mapper/` (new).
- Risk level: **low**. Pure function, no shared state, no deps. Worst case is a missed mapping rule, caught by fixtures.
