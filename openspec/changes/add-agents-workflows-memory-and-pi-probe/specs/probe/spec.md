# Delta: probe

## MODIFIED Requirements

### Requirement: Probe Endpoint

The system SHALL expose `GET /api/probe` returning a structured capability matrix. The response SHALL include:

```ts
{
  pi: {
    ok: boolean;
    version?: string;     // present when ok = true; matches /^\d+\.\d+\.\d+/
    latencyMs?: number;   // present when ok = true; the round-trip ms of the actual `pi --version` spawn
    error?: string;       // present when ok = false
  };
  confluence: { ok: boolean; configured: boolean; error?: string };
  skills: { count: number };
  agents: { count: number };
  workflows: { count: number };
  memory: { count: number };
  auth: { piAuthJsonPresent: boolean };
  workspace: { skillsDir: string; kbRoot: string; runsDir: string };
}
```

The endpoint is cookie-gated; an unauthed request returns `401 AUTH_REQUIRED`.

The `pi.ok` field MUST reflect a real spawn of `pi --version`, not the existence of `~/.pi/agent/auth.json`. The probe MUST timeout the spawn at 3000ms and return `{ok:false, error:<string>}` if the process does not exit cleanly within that window.

#### Scenario: Real pi spawn returns version + latency

- **GIVEN** `pi` is on PATH and prints `0.73.0` on `--version`
- **WHEN** an authenticated client sends `GET /api/probe`
- **THEN** the response body's `pi.ok` is `true`
- **AND** `pi.version` matches `/^\d+\.\d+\.\d+/`
- **AND** `pi.latencyMs` is a positive integer

#### Scenario: Pi missing from PATH reports ok:false with a clear error

- **GIVEN** `pi` is NOT on PATH
- **WHEN** the probe is invoked
- **THEN** the response body's `pi.ok` is `false`
- **AND** `pi.error` is a non-empty string mentioning `ENOENT` or `not found`

#### Scenario: Pi --version that takes > 3s times out

- **GIVEN** `pi --version` simulated to hang for 5 seconds
- **WHEN** the probe is invoked
- **THEN** within ~3 seconds the response body's `pi.ok` is `false`
- **AND** `pi.error` mentions `timed out` (or similar) and includes the timeout value

#### Scenario: Skill / agent / workflow / memory counts are populated

- **GIVEN** the workspace contains 3 skills, 1 agent, 0 workflows, 2 memory files
- **WHEN** the probe is invoked
- **THEN** the response body matches `{skills: {count: 3}, agents: {count: 1}, workflows: {count: 0}, memory: {count: 2}}`

#### Scenario: Workspace section reports both kbRoot and skillsDir

- **WHEN** the probe is invoked
- **THEN** the response body's `workspace` object has both `kbRoot` (the new field, absolute path) and `skillsDir` (back-compat, equals `<kbRoot>/skills`)

#### Scenario: Probe is cookie-gated (unchanged)

- **WHEN** an unauthed client sends `GET /api/probe`
- **THEN** the response status is `401`
