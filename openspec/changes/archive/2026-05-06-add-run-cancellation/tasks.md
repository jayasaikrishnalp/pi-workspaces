# Tasks: Run Cancellation

## 1. Type updates

- [x] 1.1 `src/types/run.ts` — add `'cancelling'` to `RunStatus`.

## 2. Bridge

- [x] 2.1 `src/server/pi-rpc-bridge.ts` — `abort(runId)` method: writes `{id:"abort-<id>", type:"abort"}`; arms SIGTERM(3s)/SIGKILL(4s) timers on the pi process group; stores timers on `ActiveRun` so a clean exit cancels them.
- [x] 2.2 In the run.completed branch, accept `cancelling` in the CAS expected set: `casStatus(['running','cancelling'], status)`.
- [x] 2.3 In `terminalize()` (synthetic exit/error path), accept `cancelling` similarly so a SIGTERM-driven exit during cancellation maps to `cancelled` not `error`.
- [x] 2.4 In `finishActive()`, clear the abort timers if any are still armed.

## 3. Routes

- [x] 3.1 `src/routes/runs.ts` — new `handleRunAbort(req, res, w)` exposed at `POST /api/runs/:runId/abort`. Looks up status, returns 404 / 200 (alreadyFinished) / 202.
- [x] 3.2 On a 202, the handler MUST: CAS to cancelling → persist+emit `run.cancelling` → call `bridge.abort(runId)` → respond 202.
- [x] 3.3 `src/server.ts` — register the new route.

## 4. Tests

- [x] 4.1 `tests/pi-rpc-bridge.test.mjs` — new fake-pi cases: abort writes the RPC, clean exit cancels timers, agent_end-first wins (status stays success), abort-after-completion is a no-op.
- [x] 4.2 `tests/runs-route.test.mjs` — POST /abort: 404 unknown, 200 already-finished, 202 happy-path, idempotency.
- [x] 4.3 `tests/integration/abort.smoke.mjs` — long real-pi prompt, abort mid-run, assert `run.completed status:"cancelled"` arrives, meta.json terminal, no descendant processes survive (best-effort `ps` check).

## 5. Review + verification

- [x] 5.1 Every requirement scenario in runs/pi-rpc deltas backed by a test.
- [x] 5.2 Full local suite green (unit + smoke + integration).
- [x] 5.3 Codex review iterated to clean.
- [x] 5.4 Markdown + PDF review bundle saved under `review/`.
- [x] 5.5 Three commits + push.
