# Skills Spec

## Purpose

Owns the workspace's skill-creation surface. Atomically writes <skillsDir>/<name>/SKILL.md, reads existing skills back as JSON, and integrates with the kb-watcher (Stage 4) so a write produces a visible kb.changed event within 1500ms — the demo's 'save that as a skill' loop.

## Requirements

### Requirement: Create A Skill

The system SHALL expose `POST /api/skills` accepting JSON `{name: string, content?: string, frontmatter?: object}`. The handler MUST:

- Reject `name` not matching `/^[a-z][a-z0-9-]{0,63}$/` with `400 INVALID_SKILL_NAME`.
- Reject `content` longer than 32_768 characters with `400 BODY_TOO_LARGE`.
- Reject when `<skillsDir>/<name>/SKILL.md` already exists with `409 SKILL_EXISTS`.
- Write the SKILL.md atomically (tmp + rename); the `*.tmp` file MUST NOT remain after success.
- Always emit a `name:` line in the YAML frontmatter that matches the request `name`, even if the caller's `frontmatter` object omits it or contradicts it.
- Return `201` with body `{name, path}` where `path` is relative to skillsDir.

#### Scenario: Valid POST creates the SKILL.md atomically

- **GIVEN** the workspace's `.pi/skills/` does not contain `runbook-foo`
- **WHEN** a client sends `POST /api/skills {name:"runbook-foo", content:"# Foo\n", frontmatter:{description:"x"}}`
- **THEN** the response status is `201`
- **AND** `<skillsDir>/runbook-foo/SKILL.md` exists and parses with `name: runbook-foo` and `description: x`
- **AND** no `<skillsDir>/runbook-foo/SKILL.md.tmp` file remains

#### Scenario: Invalid name is rejected

- **WHEN** a client sends `POST /api/skills {name:"Bad Name!", content:""}`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"INVALID_SKILL_NAME", ...}}`
- **AND** no file is created

#### Scenario: Pre-existing skill is rejected

- **GIVEN** `<skillsDir>/already/SKILL.md` exists
- **WHEN** a client sends `POST /api/skills {name:"already", content:"x"}`
- **THEN** the response status is `409`
- **AND** the body matches `{"error":{"code":"SKILL_EXISTS", ...}}`
- **AND** the existing file is unchanged

#### Scenario: Body too large is rejected

- **WHEN** a client sends `POST /api/skills` with `content` that is 33 KB long
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"BODY_TOO_LARGE", ...}}`

### Requirement: Read A Skill

The system SHALL expose `GET /api/kb/skill/:name` returning the parsed contents of `<skillsDir>/<name>/SKILL.md` as JSON `{name, frontmatter, body, path}`. Name validation matches the create endpoint.

#### Scenario: Existing skill is returned

- **GIVEN** `<skillsDir>/runbook-foo/SKILL.md` exists with frontmatter `{name: runbook-foo, description: x}` and body `"# foo\n"`
- **WHEN** a client sends `GET /api/kb/skill/runbook-foo`
- **THEN** the response status is `200`
- **AND** the body matches `{"name":"runbook-foo","frontmatter":{"name":"runbook-foo","description":"x"},"body":"# foo\n","path":"runbook-foo/SKILL.md"}`

#### Scenario: Missing skill returns 404

- **GIVEN** no skill named `nope` exists
- **WHEN** a client sends `GET /api/kb/skill/nope`
- **THEN** the response status is `404`

#### Scenario: Invalid name on read is rejected

- **WHEN** a client sends `GET /api/kb/skill/Bad%20Name`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"INVALID_SKILL_NAME", ...}}`

### Requirement: Skill Creation Is Visible Through Kb Channel

The system SHALL guarantee that a `POST /api/skills` write produces a `kb.changed` event on the kb-event-bus within 1500ms (matching the Stage 4 watcher's stability threshold + delivery margin), and that a subsequent `GET /api/kb/graph` includes the new skill as a node.

#### Scenario: End-to-end demo loop — write, watch, graph

- **GIVEN** the workspace has N skills and a client connected to `GET /api/kb/events`
- **WHEN** the client POSTs a new skill named `created-via-api`
- **THEN** within 1500ms the kb client receives a `kb.changed` event with `data.kind:"add"` and `data.skill:"created-via-api"`
- **AND** a subsequent `GET /api/kb/graph` returns N+1 nodes including the new one


### Requirement: Update A Skill (Live Edit)

The system SHALL expose `PUT /api/skills/:name` accepting JSON `{content?: string, frontmatter?: object}`. The handler MUST:

- Reject when `<kbRoot>/skills/<name>/SKILL.md` does not exist with `404 UNKNOWN_SKILL`.
- Reject `name` not matching `/^[a-z][a-z0-9-]{0,63}$/` with `400 INVALID_SKILL_NAME` (defense-in-depth).
- Reject `content` longer than 32_768 characters with `400 BODY_TOO_LARGE`.
- Reject when `frontmatter` contains a non-string scalar or mixed array with `400 INVALID_FRONTMATTER`.
- ALWAYS preserve the `name` frontmatter field — caller cannot rename via PUT (rename = delete + create).
- Merge: when the request omits `content`, the existing body is preserved. When it omits `frontmatter`, existing frontmatter is preserved (only `name` is locked). When provided, `frontmatter` REPLACES the prior frontmatter object except `name`.
- Write atomically via tmp + rename in place (no mkdir reservation needed; the directory already exists).
- Return `200 {name, path}`.

This endpoint is the live-edit surface the frontend uses to save changes from the skill detail view.

#### Scenario: PUT replaces only content when frontmatter is omitted

- **GIVEN** a skill `runbook-foo` with frontmatter `{name: runbook-foo, description: "old"}` and body `"# Old\n"`
- **WHEN** a client sends `PUT /api/skills/runbook-foo {content: "# New\n"}`
- **THEN** the response status is `200`
- **AND** the file's frontmatter still has `description: "old"` and the body is now `"# New\n"`

#### Scenario: PUT cannot rename via frontmatter

- **GIVEN** a skill `runbook-foo`
- **WHEN** a client sends `PUT /api/skills/runbook-foo {frontmatter: {name: "evil", description: "x"}}`
- **THEN** the response status is `200`
- **AND** the file's frontmatter `name` is still `runbook-foo` (the request's `name` was overridden)

#### Scenario: PUT on a missing skill returns 404

- **WHEN** a client sends `PUT /api/skills/no-such {content: "x"}`
- **THEN** the response status is `404`
- **AND** the body matches `{"error":{"code":"UNKNOWN_SKILL", ...}}`
- **AND** no file is created

#### Scenario: PUT with body > 32_768 chars returns 400

- **WHEN** a client sends `PUT /api/skills/runbook-foo {content: "x".repeat(40_000)}`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"BODY_TOO_LARGE", ...}}`
- **AND** the file is unchanged
