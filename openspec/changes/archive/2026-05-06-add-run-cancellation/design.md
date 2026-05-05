# Design: Run Cancellation

## Approach

The HTTP route is thin; the bridge owns the lifecycle.

```
POST /api/runs/:runId/abort
  │
  ▼
runs route handler:
  1. Look up run-store status.
     - null  → 404 UNKNOWN_RUN
     - terminal (success/error/cancelled) → 200 {alreadyFinished:true}
  2. CAS status running → cancelling. If CAS fails because something already
     transitioned the run, return 200 {alreadyFinished:true}.
  3. Emit run.cancelling on the bus (persisted via run-store, gets a fresh seq).
  4. Bridge.abort(runId): writes {id:"abort-<runId>", type:"abort"} to pi
     stdin, arms 3s SIGTERM and 4s SIGKILL on the pi process group.
  5. Return 202 {cancelled:true}.

Bridge / pi child:
  - Either pi processes the abort and emits agent_end with
    stopReason:"aborted" → mapper produces run.completed
    status:"cancelled" → bridge persists, casStatus(['running','cancelling']
    → cancelled), emits.
  - OR the SIGTERM lands first → bridge.onExit synthesizes
    pi.error + run.completed status:"cancelled" (NOT "error", because
    cancelling was the intent).
  - OR neither (rare): SIGKILL forces exit → same path as SIGTERM.

  In all paths, the bridge guards against double-emission by checking
  `active.terminalized` before producing run.completed, and by passing
  ['running','cancelling'] as the expected set to casStatus.
```

## Architecture changes

`PiRpcBridge`:
- New method `abort(runId): Promise<void>` — writes the abort RPC, arms the kill timers, awaits the active run's completion.
- The kill timers are stored on `ActiveRun` so a clean exit cancels them.
- Status mapping in the run.completed branch must accept "cancelled" coming from the mapper (which gets `status: "cancelled"` from `agent_end stopReason:"aborted"`) and skip the CAS if the run already moved to `success`. In other words: "agent_end first wins" — even if cancellation was requested, if pi completed cleanly before the abort was processed, status stays `success`.

`runs` route:
- New POST handler under `/api/runs/:runId/abort`.
- Same path matching used for the GET (extended to include POST).

`run-store`:
- No new methods. The existing `casStatus(expected, next)` already accepts an array of expecteds; we now use `['running']` to flip to `cancelling`, and `['running','cancelling']` to flip to `cancelled`. The "agent_end first wins" guard is implicit: if status is already `success`, both CAS calls return false.

## Data model

`RunStatus` already includes `'cancelled'`. Add `'cancelling'` to the union.

```ts
// src/types/run.ts
export type RunStatus = 'running' | 'cancelling' | 'success' | 'error' | 'cancelled'
```

The mapper (Stage 1) already produces `status: "cancelled"` from
`agent_end stopReason:"aborted"`. No mapper change needed.

## Decisions

- **Decision:** Always return 200 (not 204) for an already-finished run.
  **Alternatives:** 204 No Content per locked spec §2.5.
  **Why:** the SRE retry path benefits from a tiny JSON body that reports `alreadyFinished:true`, so the client doesn't have to issue a second GET to learn whether anything happened. A small spec deviation justified by ergonomics.

- **Decision:** Status transition is `running → cancelling → cancelled`, not `running → cancelled` directly.
  **Alternatives:** flip directly to cancelled before pi confirms.
  **Why:** the SSE viewers want a "cancelling..." indicator while waiting for pi (or the SIGTERM) to close out. The intermediate state also makes the agent_end-first-wins guard explicit: the CAS that flips to `cancelled` accepts BOTH `running` and `cancelling` as expected, so a real `agent_end` racing the cancellation gets to flip to `success` first if it lands before our CAS to cancelled.

- **Decision:** SIGTERM at 3s, SIGKILL at 4s.
  **Alternatives:** different timeouts; only SIGTERM; immediate kill.
  **Why:** locked spec values. 3s gives pi a chance to drain whatever it was streaming and close cleanly, 4s caps the worst case (SIGTERM ignored) at 1s.

- **Decision:** Kill the process group, not just the pi pid.
  **Why:** pi spawns subagents (Stage 6 will exercise this fully). They inherit the process group from `detached: true`. `process.kill(-pid, ...)` reaches the whole tree.

- **Decision:** `run.cancelling` is persisted (gets a seq), not a transient bus-only event.
  **Alternatives:** emit it without going through run-store.
  **Why:** SSE replay needs to surface "this run was cancelled" to a late subscriber, including the moment the cancel started. Persisting it keeps the run log self-describing.

## Affected files & packages

Modified:
- `src/types/run.ts` — add `'cancelling'` to `RunStatus`.
- `src/server/pi-rpc-bridge.ts` — `abort()` method, kill timers on `ActiveRun`, accept `cancelling` in run.completed CAS.
- `src/routes/runs.ts` — `POST /api/runs/:runId/abort` handler.
- `src/server.ts` — route table entry for the new POST.
- `tests/pi-rpc-bridge.test.mjs` — new abort cases.

New:
- `tests/integration/abort.smoke.mjs` — long-prompt abort vs real pi, with process-tree check.

## Risks & mitigations

- **Risk:** SIGKILL leaks subagent zombies if their parent didn't reap them.
  **Mitigation:** the negative-PID kill kills the whole process group, including grandchildren. Verified by the integration smoke listing `ps -o pid,ppid,pgid,cmd -g <pgid>` after abort.
- **Risk:** `agent_end` and abort racing produce a `cancelled` status when the model finished cleanly (or vice versa).
  **Mitigation:** the casStatus expected-set explicitly handles both ordering — first writer wins; second is a no-op.
- **Risk:** SIGTERM fires after pi already exited cleanly, the kill goes to a defunct process.
  **Mitigation:** the bridge stores the kill timers on `ActiveRun` and clears them in `finishActive()`. `process.kill` against a non-existent pid throws ESRCH; we catch and log.
- **Risk:** `run.cancelling` is emitted but the abort RPC fails to write.
  **Mitigation:** the route's response is 202 only after the bridge confirms the write; on error, the route returns 500 and the run-store's status remains `cancelling` until pi exit (or until the SIGTERM/SIGKILL escalation lands).
