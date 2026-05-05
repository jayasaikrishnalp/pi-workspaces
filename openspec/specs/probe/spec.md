# Probe Spec

## Purpose

Capability matrix exposed at GET /api/probe — pi reachability, Confluence configuration, skill count, pi auth.json presence. Cookie-gated. The frontend uses this to render an honest startup screen.

## Requirements

### Requirement: Probe Endpoint

The system SHALL expose `GET /api/probe` returning a structured capability matrix. The response SHALL include:

```ts
{
  pi: { ok: boolean; version?: string; error?: string };
  confluence: { ok: boolean; configured: boolean; error?: string };
  skills: { count: number };
  auth: { piAuthJsonPresent: boolean };
  workspace: { skillsDir: string; runsDir: string };
}
```

The endpoint is cookie-gated; an unauthed request returns `401 AUTH_REQUIRED`.

#### Scenario: Probe returns the workspace's capability matrix

- **GIVEN** an authenticated client
- **WHEN** the client sends `GET /api/probe`
- **THEN** the response status is `200`
- **AND** the body has `pi.ok` boolean, `confluence.configured` boolean, `skills.count` integer ≥ 0, `auth.piAuthJsonPresent` boolean, and a `workspace` object with absolute paths

#### Scenario: Probe with missing Confluence config reports configured:false

- **GIVEN** an authenticated client and no `ATLASSIAN_API_TOKEN` / `JIRA_TOKEN` set in env
- **WHEN** the client sends `GET /api/probe`
- **THEN** the response body's `confluence.configured` is `false`
- **AND** `confluence.error` is a non-empty string explaining what's missing

#### Scenario: Probe is cookie-gated

- **WHEN** an unauthed client sends `GET /api/probe`
- **THEN** the response status is `401`
