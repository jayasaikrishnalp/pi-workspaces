# Delta: agents

## MODIFIED Requirements

### Requirement: Create An Agent

The system SHALL expose `POST /api/agents` accepting JSON `{name, description?, persona?, skills, soul?}`. The `skills` array is required and MUST contain at least one element; each entry MUST match an existing skill in `<kbRoot>/skills/`. The `soul` field is optional; when provided, it MUST match an existing soul in `<kbRoot>/souls/`. The handler MUST:

- Reject `name` not matching `/^[a-z][a-z0-9-]{0,63}$/` with `400 INVALID_AGENT_NAME`.
- Reject any unknown skill ref with `400 INVALID_AGENT_SKILLS` and `details.missing` listing the bad refs.
- Reject an unknown soul ref with `400 UNKNOWN_SOUL`.
- Reject duplicate names with `409 AGENT_EXISTS`.
- On success: write `<kbRoot>/agents/<name>/AGENT.md` atomically and return `201 {name, path}`.

#### Scenario: Agent with valid soul ref is accepted

- **GIVEN** souls `stoic-operator` and skills `reboot-server` exist
- **WHEN** a client `POST /api/agents {name:"oncall", skills:["reboot-server"], soul:"stoic-operator"}`
- **THEN** the response status is `201`
- **AND** the file's frontmatter has `soul: stoic-operator`

#### Scenario: Agent with unknown soul ref returns 400

- **GIVEN** no soul named `ghost` exists
- **WHEN** a client `POST /api/agents {name:"x", skills:["a-skill"], soul:"ghost"}`
- **THEN** the response status is `400`
- **AND** `error.code` is `UNKNOWN_SOUL`
