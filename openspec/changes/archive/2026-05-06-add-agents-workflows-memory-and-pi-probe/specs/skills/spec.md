# Delta: skills

## ADDED Requirements

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
