# Proposal: Run Cancellation

## Why

Stage 2 ships the chat spine but a long pi run cannot be stopped. An SRE who realizes pi is going down a rabbit hole has to either kill the workspace process or wait it out. Neither is acceptable for a "fix at 2am" tool. Cancellation must be:

1. Cheap — one POST closes the run.
2. Clean — the pi child *and any subagents it spawned* terminate, not just the top-level process.
3. Idempotent — clicking "abort" twice doesn't error.
4. Race-safe — if `agent_end` arrives at exactly the same moment as the abort, the run lands in a defined status, not split-brain.

The locked spec §2.5 specifies the full protocol. This change implements it.

## What changes

- New endpoint `POST /api/runs/:runId/abort`. Returns `200 {alreadyFinished:true}` if the run already terminated, `202 {cancelled:true}` if the abort was actually issued, `404` if the run is unknown.
- Bridge: `abort(runId)` writes `{id: "abort-<runId>", type: "abort"}` to pi's stdin and arms a 3s/4s SIGTERM/SIGKILL escalation against the pi process group.
- New event `run.cancelling` emitted on the bus immediately after the status CAS, before the abort RPC is sent. Lets SSE clients show a "cancelling..." indicator.
- run-store: a new transition `running → cancelling → cancelled`, with `casStatus` accepting `cancelling` as a valid expected for the final `cancelled` flip. Guard: if `agent_end` arrives first (`success`), the run stays `success` and the cancellation is recorded as a no-op.
- pi child spawned `detached: true` already (Stage 2). Cancellation uses `process.kill(-pid, ...)` to reach the process group, including subagent descendants.

## Scope

**In scope**
- The full POST /api/runs/:runId/abort flow per locked spec §2.5.
- Tracker / run-store / bus updates.
- Unit tests with the fake-pi child to assert: status transitions, run.cancelling emission, run.completed-idempotency, "agent_end first wins", abort-after-completion is a no-op.
- A real-pi integration smoke that submits a long prompt, aborts mid-run, and asserts the SSE stream closes with `run.completed status:"cancelled"`.

**Out of scope**
- Per-tool granular cancellation. We cancel the whole run.
- Resumability after cancel.
- A frontend UI for abort. Stage 8+.
- Retrying the same prompt automatically after a cancel.

## Impact

- Affected specs: `runs` (cancellation transition + endpoint), `pi-rpc` (abort method + process-group kill semantics).
- Affected code: `src/server/pi-rpc-bridge.ts` (abort method + escalation timers), `src/routes/runs.ts` (POST handler), `src/server.ts` (route registration), `tests/pi-rpc-bridge.test.mjs` (new abort cases), new `tests/integration/abort.smoke.mjs` for end-to-end.
- Risk level: medium. The status-race guard is the critical correctness item; everything else is mechanical.
