# Delta: souls

## ADDED Requirements

### Requirement: Soul Files

The system SHALL discover souls under `<kbRoot>/souls/<name>/SOUL.md`. Each `SOUL.md` MUST be parsed for YAML frontmatter (delimited by leading `---\n` and `\n---\n`). The frontmatter `name` field is required. Optional frontmatter fields: `description`, `values` (string[]), `priorities` (string[]), `risk_tolerance` (string), `decision_principles` (string[]), `tone` (string), `model_preference` (string).

A Soul is the agent's character/identity definition — the values, priorities, and decision principles that shape how the agent reasons. Multiple agents MAY reference the same Soul.

#### Scenario: A soul file produces one soul node

- **GIVEN** `<kbRoot>/souls/stoic-operator/SOUL.md` with valid frontmatter
- **WHEN** the graph is built
- **THEN** `nodes` contains an entry with `id:"stoic-operator"`, `source:"soul"`, and `path:"souls/stoic-operator/SOUL.md"`

### Requirement: Soul CRUD Endpoints

The system SHALL expose:

- `GET /api/souls` — list all souls with `{name, description?}`.
- `POST /api/souls` accepting `{name, description?, values?[], priorities?[], risk_tolerance?, decision_principles?[], tone?, model_preference?, body?}`. Returns `201 {name, path}`. Errors: `400 INVALID_SOUL_NAME` (regex `^[a-z][a-z0-9-]{0,63}$`), `400 BODY_TOO_LARGE` (>32KB), `409 SOUL_EXISTS`.
- `GET /api/souls/:name` — returns `{name, frontmatter, body, path}`. `404 UNKNOWN_SOUL` if missing.
- `PUT /api/souls/:name` — merge semantics, name-locked. Same error envelope as agent PUT.

#### Scenario: POST creates a soul, GET reads it back

- **GIVEN** no soul named `stoic-operator` exists
- **WHEN** a client `POST /api/souls {name:"stoic-operator", description:"calm under fire", values:["honesty","caution"]}`
- **THEN** the response status is `201`
- **AND** a subsequent `GET /api/souls/stoic-operator` returns `frontmatter.values == ["honesty","caution"]`

#### Scenario: POST same name twice → 409 SOUL_EXISTS

- **GIVEN** a soul `dup` exists
- **WHEN** a client POSTs another soul with `name:"dup"`
- **THEN** the response status is `409`
- **AND** the body matches `{"error":{"code":"SOUL_EXISTS"}}`

### Requirement: Embodies Edges

When a soul is referenced by one or more agents (via the agent's optional `soul:` frontmatter field), the system SHALL emit one `embodies` edge per such relationship in the kb graph: `{source: "<agent>", target: "<soul>", kind: "embodies"}`. Dangling soul references on agent files MUST surface as `severity:"warn"` diagnostics and MUST NOT prevent the agent from appearing in the graph.

#### Scenario: Agent referencing a soul produces an embodies edge

- **GIVEN** an agent `oncall` with frontmatter `soul: stoic-operator` and a soul `stoic-operator` exists
- **WHEN** the graph is built
- **THEN** edges include `{source:"oncall", target:"stoic-operator", kind:"embodies"}`

#### Scenario: Dangling soul ref produces a diagnostic, not a hard failure

- **GIVEN** an agent `broken` with frontmatter `soul: ghost` and no soul named `ghost` exists
- **WHEN** the graph is built
- **THEN** the agent `broken` appears in nodes with `source:"agent"`
- **AND** no edge from `broken` to `ghost` exists
- **AND** diagnostics contains a `severity:"warn"` entry naming `ghost`
