# Delta: kb

## MODIFIED Requirements

### Requirement: Discover Skills

The system SHALL discover entities under `<kbRoot>/<kind>/<name>/<KIND>.md` for `kind ∈ {skills, agents, workflows}`. Each file MUST be parsed for YAML frontmatter (delimited by leading `---\n` and `\n---\n`). The frontmatter `name` field is required for all kinds. Skills accept `description`, `tags`, `uses`. Agents accept `description`, `persona`, and require `skills` (string[]). Workflows accept `description` and require `steps` (string[] of `"<kind>:<ref>"` entries).

#### Scenario: Five seed skills produce five skill nodes

- **GIVEN** `<kbRoot>/skills/` contains the five seed SKILL.md files
- **WHEN** a client sends `GET /api/kb/graph`
- **THEN** the response status is `200`
- **AND** the body contains exactly five nodes with `source:"skill"`, one per seed
- **AND** each node has `id`, `name`, `description`, `path`, `source: "skill"`

#### Scenario: An agent file produces one agent node

- **GIVEN** `<kbRoot>/agents/sre-bot/AGENT.md` with valid frontmatter
- **WHEN** the graph is built
- **THEN** `nodes` contains an entry with `id:"sre-bot"`, `source:"agent"`, and `path:"agents/sre-bot/AGENT.md"`

#### Scenario: A workflow file produces one workflow node

- **GIVEN** `<kbRoot>/workflows/safe-reboot/WORKFLOW.md` with valid frontmatter
- **WHEN** the graph is built
- **THEN** `nodes` contains an entry with `id:"safe-reboot"`, `source:"workflow"`, and `path:"workflows/safe-reboot/WORKFLOW.md"`

## ADDED Requirements

### Requirement: Edge Kinds Across Domains

The system SHALL emit edges of four kinds across the three KB domains:

- `uses` — directed, skill → skill, derived from a skill's `uses:` frontmatter array.
- `link` — directed, skill → skill, derived from a skill body's `[[wikilink]]` references.
- `composes` — directed, agent → skill, one per entry in an agent's `skills` array.
- `step` — directed, workflow → skill OR workflow → workflow, one per entry in a workflow's `steps` array.

Duplicate edges (same source, target, kind) MUST be collapsed to one. References to nonexistent entities MUST NOT produce edges; instead they surface as `severity:"warn"` diagnostics.

#### Scenario: Agent with two skills emits two composes edges

- **GIVEN** an agent `bot` with `skills: [a, b]` where both `a` and `b` exist as skills
- **WHEN** the graph is built
- **THEN** edges include exactly `{source:"bot", target:"a", kind:"composes"}` and `{source:"bot", target:"b", kind:"composes"}`

#### Scenario: Workflow step referencing a workflow produces a step edge between workflows

- **GIVEN** a workflow `outer` with step `workflow:inner`, and a workflow `inner` exists
- **WHEN** the graph is built
- **THEN** edges include `{source:"outer", target:"inner", kind:"step"}`

#### Scenario: Dangling agent skill ref does not break the graph

- **GIVEN** an agent `broken` whose `skills` references `ghost` which is not a known skill
- **WHEN** the graph is built
- **THEN** `nodes` includes an entry for `broken` with `source:"agent"`
- **AND** no edge from `broken` to `ghost` exists
- **AND** `diagnostics` includes a `severity:"warn"` entry whose path is the agent file and whose message names `ghost`

### Requirement: Watcher Roots At kbRoot

The system's filesystem watcher SHALL root at `<kbRoot>` (not `<kbRoot>/skills` as before). It MUST emit `kb.changed` events for any add/change/unlink/addDir/unlinkDir under `<kbRoot>/skills/`, `<kbRoot>/agents/`, `<kbRoot>/workflows/`, and `<kbRoot>/memory/`.

#### Scenario: Adding an AGENT.md emits a kb.changed event

- **GIVEN** a client subscribed to `GET /api/kb/events`
- **WHEN** a file is written atomically to `<kbRoot>/agents/new-bot/AGENT.md`
- **THEN** within 1500ms the client receives a `kb.changed` event whose `data.path` ends in `agents/new-bot/AGENT.md`

#### Scenario: Adding a memory file emits a kb.changed event but does NOT add a graph node

- **GIVEN** a client subscribed to `GET /api/kb/events`
- **WHEN** a file is written to `<kbRoot>/memory/preferences.md`
- **THEN** within 1500ms a `kb.changed` event arrives with `data.path` ending in `memory/preferences.md`
- **AND** a subsequent `GET /api/kb/graph` does NOT include `preferences` as a node
