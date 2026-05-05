# Proposal: Pi-RPC Bridge + Chat Event Bus + Run Store

## Why

Stage 1 normalized pi events. Stage 2 makes them flow:

1. **Connect to pi.** The workspace must spawn `pi --mode rpc`, send prompts via stdin, parse the JSON-line event stream from stdout, and survive pi crashes by restarting the child.
2. **Persist runs.** Every event a run produces must be stamped with a monotonic `seq` and an `eventId`, written atomically to disk, and kept until at least the next workspace restart. Otherwise a browser refresh in the middle of a long pi run loses the conversation.
3. **Reach browsers reliably.** Two SSE channels: a per-run replay-aware channel (`GET /api/runs/:runId/events?afterSeq=N`) that does atomic backlog+live without races, and a per-session live-only channel (`GET /api/chat-events`). Both use the single-handler `queueing → streaming` pattern from §2.4 so the second-subscribe race that haunts naive bus implementations doesn't bite.
4. **Reject conflicting prompts.** One run per session at a time. A second `POST /api/send-stream` while a run is in flight must 409, not silently spawn a parallel pi prompt that pi itself can't service.

Stage 0 gave us a server. Stage 1 gave us a translator. Stage 2 gives us *the chat spine*. Cancellation, KB, Confluence, skills, frontend — everything later builds on this.

## What changes

- New `pi-rpc` capability: a long-lived child process owning pi's RPC stdin/stdout, with prompt send, event emit, restart-on-crash.
- New `runs` capability: per-run event log with monotonic `seq`, `eventId = "${runId}:${seq}"`, atomic append, replay query, status CAS.
- New `sessions` capability: session creation, listing, active-run lookup. Minimum viable subset; richer per-cwd JSONL session store remains out of scope until needed.
- Extension of `events`: chat event bus (singleton on globalThis) that brokers normalized events from the bridge to subscribers and stamps run metadata.
- New endpoints:
  - `POST /api/sessions` — create.
  - `GET /api/sessions` — list.
  - `GET /api/sessions/:sessionKey/active-run` — dedup hint.
  - `POST /api/send-stream` — submit a prompt, returns 202 `{runId}`.
  - `GET /api/chat-events?sessionKey=&tabId=` — SSE live tail, session-scoped.
  - `GET /api/runs/:runId/events?afterSeq=` — SSE replay-aware.
- Two end-to-end smoke tests against a real pi process on the VM:
  - "POST then SSE": prompt is sent, browser opens replay channel, every expected event arrives in order with monotonic `seq` and unique `eventId`.
  - "SSE then POST": browser opens live channel, prompt is sent, every event still arrives.

## Scope

**In scope**
- The pi child process lifecycle (spawn detached with own process group, stdin queue, stdout line buffer, restart-on-crash with exponential backoff).
- Run-store on disk at `~/.pi-workspace/runs/<runId>/{events.jsonl,meta.json}`, atomic via tmp+rename.
- Replay SSE handler with the queueing→streaming pattern (locked spec §2.4 — applied verbatim).
- 409 dedup on a second prompt while a run is in flight.
- A pure server-side smoke harness that drives a live pi and asserts the event sequence.

**Out of scope**
- Cancellation / abort. Stage 3.
- KB events / file watcher. Stage 4 (separate channel and bus).
- Confluence search. Stage 5.
- Skill creation. Stage 6.
- Auth middleware. Stage 7. For now the new endpoints accept any caller; Stage 7 layers cookie checks on top.
- The frontend. Stage 8+.
- Multiple pi children, model switching, multi-cwd sessions, `Last-Event-ID` header in addition to `?afterSeq=` (the locked spec allows either; Stage 2 ships `?afterSeq=` and adds the header read in Stage 7 or later if needed).

## Impact

- Affected specs: `pi-rpc` (new), `runs` (new), `sessions` (new), `events` (extended with the bus).
- Affected code: `src/server/{pi-rpc-bridge,chat-event-bus,run-store,send-run-tracker}.ts`, `src/routes/{sessions,send-stream,chat-events,runs}.ts`, `src/server.ts` (route table extended), tests under `tests/integration/` driving real pi, fixtures.
- Risk level: **high** by design — this is the largest stage. Mitigations: every architectural decision is committed in `design.md` before code is written; integration tests run against the real pi child on the VM (no mocks), so what we test is what production runs.
