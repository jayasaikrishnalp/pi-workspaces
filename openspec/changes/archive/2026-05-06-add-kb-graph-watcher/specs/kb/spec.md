# Delta: kb

## ADDED Requirements

### Requirement: Discover Skills

The system SHALL discover skills under `<workspaceCwd>/.pi/skills/<name>/SKILL.md`. Each `SKILL.md` MUST be parsed for YAML frontmatter (delimited by leading `---\n` and `\n---\n`). The frontmatter `name` field is required; `description`, `tags` (string array), and `uses` (string array) are optional.

#### Scenario: Five seed skills produce five nodes

- **GIVEN** the workspace `.pi/skills/` contains the five seed SKILL.md files
- **WHEN** a client sends `GET /api/kb/graph`
- **THEN** the response status is `200`
- **AND** the body contains exactly five nodes, one per seed
- **AND** each node has `id`, `name`, `description`, `path`, `source: "skill"`

### Requirement: Graph Edges From `uses` And Wikilinks

The system SHALL emit a directed edge for each entry in a skill's `uses:` frontmatter array (`kind: "uses"`) and for each `[[skill-name]]` reference in the body (`kind: "link"`). Duplicate edges (same source, target, kind) MUST be collapsed to one. Edges referring to a non-existent skill MUST NOT be emitted; instead, a diagnostic is surfaced.

#### Scenario: `uses` frontmatter array produces directed edges

- **GIVEN** a skill `aws-cleanup` with frontmatter `uses: [check-server-health]`
- **WHEN** the graph is built
- **THEN** the edges include `{source: "aws-cleanup", target: "check-server-health", kind: "uses"}`

#### Scenario: Body wikilink produces a link edge

- **GIVEN** a skill `runbook-patch` whose body contains `See [[disk-cleanup]] before patching.`
- **WHEN** the graph is built
- **THEN** the edges include `{source: "runbook-patch", target: "disk-cleanup", kind: "link"}`

#### Scenario: Wikilink to a nonexistent skill becomes a diagnostic, not an edge

- **GIVEN** a skill `runbook-patch` whose body contains `[[nonexistent]]`
- **WHEN** the graph is built
- **THEN** the edges array does NOT contain an edge to `nonexistent`
- **AND** the diagnostics include an entry with `severity:"warn"` and a message naming the dangling reference

### Requirement: Frontmatter Diagnostics, Not Hard Failures

The system SHALL recover from malformed frontmatter by emitting a diagnostic for the offending file and continuing to process other skills. The graph endpoint MUST return `200` with whatever skills could be parsed, even when some are broken.

#### Scenario: Malformed YAML produces a diagnostic but does not break the graph

- **GIVEN** a SKILL.md with frontmatter that has an unbalanced bracket or invalid indentation
- **AND** four other valid skills exist
- **WHEN** a client sends `GET /api/kb/graph`
- **THEN** the response is `200`
- **AND** the body contains four nodes (the valid skills)
- **AND** the diagnostics include an entry whose `path` matches the malformed file and `severity` is `error`

#### Scenario: Missing `name` field produces a diagnostic

- **GIVEN** a SKILL.md whose frontmatter is missing the `name` field
- **WHEN** the graph is built
- **THEN** that file does NOT appear in nodes
- **AND** the diagnostics include `{severity:"error", path:..., message: <mentions name>}`

### Requirement: Live KB Event Channel

The system SHALL expose `GET /api/kb/events` as a Server-Sent Events stream that emits a `kb.changed` event each time chokidar reports an `add`, `change`, `unlink`, `addDir`, or `unlinkDir` under `.pi/skills/`. The KB channel MUST be separate from the chat-event channel — chat subscribers MUST NOT receive KB events and vice versa.

#### Scenario: New SKILL.md drop produces an SSE event within 200ms

- **GIVEN** a client is connected to `GET /api/kb/events`
- **WHEN** a new file is written to `.pi/skills/new-skill/SKILL.md` via atomic tmp+rename
- **THEN** within 200ms the client receives exactly one SSE message with `event: kb.changed` and `data.kind: "add"` and `data.path` ending in the new file's relative path

#### Scenario: Atomic write produces exactly one event, not a burst

- **GIVEN** a client is connected to `GET /api/kb/events`
- **WHEN** a SKILL.md is written via the standard tmp+rename pattern (write to `*.tmp`, then rename to `*.md`)
- **THEN** the client receives exactly one `kb.changed` event for the final file path
- **AND** does NOT receive separate events for the intermediate `*.tmp` file

#### Scenario: Deleting a SKILL.md produces an unlink event

- **GIVEN** a client is connected and a skill `to-remove/SKILL.md` exists
- **WHEN** the file is deleted
- **THEN** the client receives a `kb.changed` event with `data.kind: "unlink"`
- **AND** subsequent `GET /api/kb/graph` calls return a graph with the skill's node removed

### Requirement: KB Channel Is Independent Of Chat Channel

The system SHALL guarantee that subscribers to `GET /api/chat-events` do NOT receive KB events, and subscribers to `GET /api/kb/events` do NOT receive chat events.

#### Scenario: Chat subscriber does not receive kb.changed

- **GIVEN** a client subscribed to `GET /api/chat-events?sessionKey=<key>&tabId=t1`
- **WHEN** a SKILL.md is added to `.pi/skills/`
- **THEN** the chat subscriber MUST NOT receive any event for that filesystem change
