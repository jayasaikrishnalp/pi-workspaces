# Delta: pi-rpc

## ADDED Requirements

### Requirement: Bridge Abort Method

The system SHALL expose `bridge.abort(runId)` that:

1. Writes `{id: "abort-<runId>", type: "abort"}` to pi's stdin as a single JSON-line command.
2. Arms a SIGTERM timer at 3 seconds and a SIGKILL timer at 4 seconds against the pi child's process group (negative PID, reaching subagents).
3. Cancels both timers if pi exits cleanly first.
4. Throws `NO_ACTIVE_RUN` if the requested `runId` is not the in-flight run on the bridge.

#### Scenario: Abort writes the RPC command on stdin

- **GIVEN** a run `r1` is in flight on the bridge
- **WHEN** the bridge's `abort('r1')` is called
- **THEN** pi's stdin receives a JSON line of the form `{"id":"abort-r1","type":"abort"}`

#### Scenario: Pi exits cleanly within 3s; no SIGTERM is sent

- **GIVEN** a run `r1` is in flight and `bridge.abort('r1')` has been called
- **WHEN** pi processes the abort and exits (or emits `agent_end` with `stopReason:"aborted"` and the bridge calls finishActive) within 3 seconds
- **THEN** no SIGTERM/SIGKILL signal is sent to pi
- **AND** the timers are cancelled

#### Scenario: SIGTERM at 3s, SIGKILL at 4s if pi does not exit

- **GIVEN** a run `r1` is in flight and pi is unresponsive to the abort RPC
- **WHEN** 3 seconds elapse since `bridge.abort('r1')` was called
- **THEN** `process.kill(-<pi pgid>, "SIGTERM")` is invoked
- **AND** if pi has not exited by 4 seconds total, `process.kill(-<pi pgid>, "SIGKILL")` is invoked

### Requirement: Process Group Kill Reaches Subagents

The system SHALL spawn the pi child with `detached: true` so that pi and any subagents pi spawns share a process group. Cancellation MUST kill that process group, not just pi's pid, so subagent descendants are reaped.

#### Scenario: Subagent processes do not survive an abort

- **GIVEN** pi is running a tool that spawned a subagent (a separate `pi --print --mode json` child)
- **WHEN** the workspace aborts the run
- **THEN** after the bridge completes its abort flow, no descendant of the original pi process remains running on the host
