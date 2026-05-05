# Design: Pi-RPC Bridge + Chat Event Bus + Run Store

## Approach

Five collaborating components, each tested in isolation and together:

```
HTTP request                           pi child (--mode rpc)
     │                                       ▲   │
     │ POST /api/send-stream                 │   │ JSON-line events
     ▼                                       │   ▼
┌──────────────┐  bridge.send(msg, runId)  ┌────────────────┐
│ send-stream  │ ───────────────────────►  │ pi-rpc-bridge  │
│   route      │                           │ (child + parser)│
└──────┬───────┘                           └────────┬───────┘
       │ tracker.start(sk, runId)                   │ raw pi events
       ▼                                            ▼
┌──────────────┐                           ┌────────────────┐
│  send-run-   │                           │  pi-event-     │
│  tracker     │                           │  mapper        │
└──────────────┘                           └────────┬───────┘
                                                    │ NormalizedEvent[]
                                                    ▼
                                           ┌────────────────┐
       client SSE  ◄────── emit ────────── │ chat-event-bus │
       routes                              │ + run-store    │
                                           │ (seq + eventId │
                                           │  + jsonl write)│
                                           └────────────────┘
```

The mapper from Stage 1 is reused unchanged. Everything else is new.

## Architecture

### `pi-rpc-bridge`

One singleton on `globalThis.__piBridge` (so dev-time module reloads don't spawn duplicate children). Owns at most one `pi --mode rpc` child:

- Spawned `detached: true` with `stdio: ['pipe', 'pipe', 'pipe']`, in its own process group via `setsid`/POSIX defaults so we can later kill the whole tree.
- stdin: a write queue. `send(message, runId)` writes one JSON command per line. `abort(runId)` (Stage 3) writes `{type:"abort"}`.
- stdout: line-buffered parser. Every complete line is `JSON.parse`'d. Three categories:
  - `{type:"response", command, success}` — command ack. Logged; not forwarded.
  - Everything else (agent events) — passed to `mapPiEvent()` with the active run's ctx, then `bus.emit(...)` for each normalized event.
- Crash handling: child `exit` listener clears the singleton state; next `send()` respawns. Backoff: 0s, 1s, 5s, 30s; reset on a successful response.
- One in-flight prompt at a time — pi enforces this and so does our `send-run-tracker`. A second `send()` while one is in flight throws (`Error("BRIDGE_BUSY")`); the route translates it to HTTP 409.

### `chat-event-bus`

Singleton on `globalThis.__chatBus`. Pure pub/sub:

```ts
type RunMeta = { runId: string; sessionKey: string; seq: number; eventId: string }
type EnrichedEvent = NormalizedEvent & { meta: RunMeta }

interface ChatEventBus {
  subscribe(handler: (e: EnrichedEvent) => void): () => void
  emit(e: EnrichedEvent): void
}
```

The bus does not assign `seq` or `eventId` — `run-store` does, and re-publishes through the bus only after the disk write has completed (so subscribers can never receive an event that isn't yet on disk). This is the contract that lets the replay handler trust the bus is a strict suffix of disk.

### `run-store`

Per-run directory under `~/.pi-workspace/runs/<runId>/`:

```
events.jsonl   one EnrichedEvent per line, append-only
meta.json      {runId, sessionKey, prompt, status, startedAt, finishedAt?, error?}
seq.txt        last assigned seq (string of integer; rebuilt from events.jsonl on workspace startup)
```

API:

```ts
appendNormalized(
  raw: NormalizedEvent,
  runMeta: { runId; sessionKey }
): Promise<EnrichedEvent>

getEvents(runId, { afterSeq?: number }): Promise<EnrichedEvent[]>
getStatus(runId): Promise<RunStatus>
casStatus(runId, expected: RunStatus, next: RunStatus): Promise<boolean>
```

`appendNormalized` is the only writer to `events.jsonl`. It serializes via a per-run `Promise` chain so two concurrent emits can't interleave and produce out-of-order seqs:

```ts
const writeChain = new Map<runId, Promise<void>>()
async function appendNormalized(...) {
  const prev = writeChain.get(runId) ?? Promise.resolve()
  const next = prev.then(async () => doAppend(...))
  writeChain.set(runId, next)
  return next
}
```

`doAppend` does:
1. `seq = currentSeq + 1`
2. `eventId = "${runId}:${seq}"`
3. Construct `enriched = { ...raw, meta: { runId, sessionKey, seq, eventId } }`
4. `fs.appendFile(events.jsonl, JSON.stringify(enriched)+'\n')` — POSIX guarantees small atomic appends below `PIPE_BUF`; we cap individual events well below that. (For oversized events we still append; the small risk of an interleaved append is acceptable for MVP. The per-run write chain serializes anyway.)
5. Return enriched.

`casStatus` writes `meta.json` via tmp+rename for atomicity.

### `send-run-tracker`

In-memory `Map<sessionKey, runId>` plus a small lock around start/finish. `start(sk, runId)` throws `Error("ACTIVE_RUN")` if the slot is taken. `finish(sk, runId)` clears it (idempotent). State lives only in memory — surviving a workspace restart is out of scope (the user can re-POST).

### Replay handler (`/api/runs/:runId/events?afterSeq=N`)

Verbatim adoption of locked spec §2.4 — the single-handler queueing→streaming pattern. Subscribe BEFORE drain. Drain. Flush queue, dedup by numeric `seq`. Flip mode to `'streaming'`. Same handler now writes live.

A run that already finished is replayable as long as `events.jsonl` is on disk. The handler checks final status after streaming the backlog: if status is terminal (success/cancelled/error) and the queue is empty, it closes the response after writing a final SSE comment so the client sees a clean EOF without waiting for the heartbeat.

### Live handler (`/api/chat-events?sessionKey=`)

Pure live tail. No backlog, no replay. Subscribes to bus, filters by `sessionKey`, writes events as SSE. No drain race because there's nothing to drain.

### Wiring at boot

`src/server.ts` becomes thinner. New module `src/server/wiring.ts` builds the bridge → bus → run-store graph, exposes them, and the route handlers grab them via the wiring exports. Tests can substitute a fake bridge (a `setImmediate(() => bus.emit(canned events))`) without touching the rest.

## Data model

```jsonc
// ~/.pi-workspace/runs/<runId>/events.jsonl  (one per line)
{"event":"run.start","data":{"runId":"<uuid>","sessionKey":"<uuid>","prompt":"hi"},
 "meta":{"runId":"<uuid>","sessionKey":"<uuid>","seq":1,"eventId":"<uuid>:1"}}

// ~/.pi-workspace/runs/<runId>/meta.json
{ "runId":"<uuid>",
  "sessionKey":"<uuid>",
  "prompt":"hi",
  "status":"running" | "success" | "error" | "cancelled",
  "startedAt": 1778003663588,
  "finishedAt": 1778003664500,
  "error": null }

// ~/.pi-workspace/runs/<runId>/seq.txt
"42"
```

The seq.txt sidecar is a startup optimization. On boot, if it's missing or smaller than the last line of events.jsonl, we rebuild it.

## Decisions

- **Decision:** pi spawned once, reused for many prompts.
  **Alternatives:** spawn-per-prompt; pool of pi children.
  **Why:** spawn-per-prompt loses session continuity (no `--continue`) and adds latency. A pool isn't needed for single-user MVP and complicates restart.

- **Decision:** Run-store assigns seq + eventId; bus is dumb pipe.
  **Alternatives:** bus assigns seq; in-memory event log.
  **Why:** the persistence boundary IS the ordering boundary. If the disk write hasn't happened, replay can't include the event, so emitting on the bus before disk write would create a "subscriber saw it but replay didn't" inconsistency. Putting seq assignment in the run-store closes that gap.

- **Decision:** events.jsonl is the durable log; meta.json is mutable.
  **Alternatives:** SQLite; one big sessions.jsonl.
  **Why:** append-only file matches the access pattern (write once per event, read sequentially on replay). SQLite is overkill for hackathon scope. One file per run gives free per-run cleanup and avoids cross-run lock contention.

- **Decision:** Per-run write chain (Promise serialization) instead of a global mutex.
  **Alternatives:** global lock; sync writes.
  **Why:** the bridge can in principle deliver events for two different runs interleaved (after Stage 6 spawns subagents). Per-run chain keeps one run's writes ordered without blocking other runs.

- **Decision:** No `Last-Event-ID` header support yet.
  **Alternatives:** ship both `?afterSeq=` and `Last-Event-ID` now.
  **Why:** the EventSource auto-reconnect that uses `Last-Event-ID` only matters once the frontend exists. Adding it before there's a client to test with is dead code; we add it the moment Stage 8 needs it.

- **Decision:** Tracker is in-memory; restart loses active runs.
  **Alternatives:** persist tracker state.
  **Why:** if the workspace restarts, the pi child died with it (no separate process supervisor in MVP). The active run is therefore dead too. Re-POSTing is the right user behavior.

- **Decision:** Two SSE channels (per-run replay + per-session live), as the locked spec requires.
  **Alternatives:** one unified channel with optional replay.
  **Why:** the use cases differ. The per-run replay is for "show me everything that happened in run X, even if I joined late." The per-session live is for "follow whatever this session is doing now." Conflating them complicates filtering on both server and client and is exactly what the locked spec called out.

- **Decision:** Singletons on `globalThis` (bridge + bus).
  **Alternatives:** export module-level objects.
  **Why:** during dev, tsx's loader can re-evaluate modules. A module-level `new ChatEventBus()` would create a fresh instance on every reload, orphaning subscribers. `globalThis.__chatBus ??= new ChatEventBus()` survives reload.

- **Decision:** Integration tests drive real pi on the VM, not mocks.
  **Alternatives:** stub the bridge with a canned event stream.
  **Why:** Stage 1 burned us on shape assumptions; we won't repeat. The CI cost (test takes ~10s per pi prompt) is fine for a hackathon. We add unit-level mocks for run-store ordering tests only, where pi is irrelevant.

## Affected files & packages

New:
- `src/server/pi-rpc-bridge.ts`
- `src/server/chat-event-bus.ts`
- `src/server/run-store.ts`
- `src/server/send-run-tracker.ts`
- `src/server/wiring.ts`
- `src/routes/sessions.ts`
- `src/routes/send-stream.ts`
- `src/routes/chat-events.ts`
- `src/routes/runs.ts`
- `src/types/run.ts`
- `tests/integration/send-stream.smoke.mjs`
- `tests/integration/replay.smoke.mjs`
- `tests/run-store.test.mjs` (unit)
- `tests/send-run-tracker.test.mjs` (unit)

Modified:
- `src/server.ts` — pulls routes from wiring, no longer hardcodes the table.
- `package.json` — add `npm run test:integration`.

## Risks & mitigations

- **Risk:** SSE race between drain end and live emit.
  **Mitigation:** single-handler queueing→streaming exactly per locked spec §2.4. Replay test covers the race window.
- **Risk:** pi crashes mid-run leaves the bridge in a half-state.
  **Mitigation:** `child.on('exit')` clears bridge state and emits a synthetic `pi.error` for the active run; run-store flips status to `error`; the route ends the SSE stream.
- **Risk:** `events.jsonl` write fails (disk full, permission).
  **Mitigation:** per-event `appendFile` returns a rejected promise; the bridge converts that to a `pi.error` on the bus; the route logs and the client sees the error event.
- **Risk:** Tracker leak — `start()` followed by no `finish()` (e.g., bridge crash).
  **Mitigation:** the bridge's `exit` handler enumerates active runs and calls `tracker.finish()` on all of them.
- **Risk:** Two parallel POSTs racing to grab the active slot.
  **Mitigation:** the tracker's `start()` is synchronous (single-threaded JS) — both POSTs cannot pass the check simultaneously. The second one sees the slot taken and 409s.
