# Delta: agents

## ADDED Requirements

### Requirement: Create An Agent

The system SHALL expose `POST /api/agents` accepting JSON `{name: string, description?: string, skills: string[], persona?: string}`. The handler MUST:

- Reject `name` not matching `/^[a-z][a-z0-9-]{0,63}$/` with `400 INVALID_AGENT_NAME`.
- Reject when `skills` is missing, empty, or contains a non-string with `400 INVALID_AGENT_SKILLS`.
- Reject when any `skills[]` entry does not match an existing skill on disk with `400 INVALID_AGENT_SKILLS` and a diagnostic listing the offending refs.
- Reject when `<kbRoot>/agents/<name>/AGENT.md` already exists with `409 AGENT_EXISTS`.
- Write the AGENT.md atomically (mkdir-as-reservation, tmp+rename). The frontmatter MUST contain `name` (matching the request), `skills` (string[]), and optionally `description`, `persona`.
- Return `201 {name, path}` where `path` is relative to `kbRoot`.

#### Scenario: Valid POST creates an agent

- **GIVEN** skills `reboot-server` and `check-server-health` exist on disk
- **WHEN** a client sends `POST /api/agents {name:"sre-bot", skills:["reboot-server","check-server-health"], description:"on-call"}`
- **THEN** the response status is `201`
- **AND** `<kbRoot>/agents/sre-bot/AGENT.md` parses with frontmatter `name: sre-bot`, `description: on-call`, and `skills` containing both ids in order

#### Scenario: Skills referencing nonexistent skills are rejected

- **WHEN** a client sends `POST /api/agents {name:"x", skills:["nonexistent-skill"]}`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"INVALID_AGENT_SKILLS","message":<string>,"details":{"missing":["nonexistent-skill"]}, ...}}`
- **AND** no file is created

#### Scenario: Empty skills array is rejected

- **WHEN** a client sends `POST /api/agents {name:"x", skills:[]}`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"INVALID_AGENT_SKILLS", ...}}`

#### Scenario: Agent already exists returns 409

- **GIVEN** `<kbRoot>/agents/dup/AGENT.md` exists
- **WHEN** a client sends `POST /api/agents {name:"dup", skills:["reboot-server"]}`
- **THEN** the response status is `409`
- **AND** the body matches `{"error":{"code":"AGENT_EXISTS", ...}}`

### Requirement: List Agents

The system SHALL expose `GET /api/agents` returning JSON `{agents: [{name, description?, skills[]}]}` for every parsable AGENT.md under `<kbRoot>/agents/`. Agents whose frontmatter fails to parse MUST NOT appear in the list; their problems surface through the kb diagnostics channel.

#### Scenario: List enumerates all agents

- **GIVEN** two parseable agents `a1` and `a2` on disk
- **WHEN** a client sends `GET /api/agents`
- **THEN** the body matches `{"agents": [{"name":"a1","skills":[...]}, {"name":"a2","skills":[...]}]}` (order not specified)

### Requirement: Read An Agent

The system SHALL expose `GET /api/agents/:name` returning JSON `{name, frontmatter, body, path}`. Name validation matches the create endpoint.

#### Scenario: Existing agent is returned

- **GIVEN** `<kbRoot>/agents/sre-bot/AGENT.md` with frontmatter `{name: sre-bot, skills: [reboot-server], description: x}` and body `"# bot\n"`
- **WHEN** a client sends `GET /api/agents/sre-bot`
- **THEN** the response status is `200`
- **AND** `frontmatter.name === "sre-bot"` and `frontmatter.skills` contains `"reboot-server"`

#### Scenario: Missing agent returns 404 UNKNOWN_AGENT

- **WHEN** a client sends `GET /api/agents/nope`
- **THEN** the response status is `404`
- **AND** the body matches `{"error":{"code":"UNKNOWN_AGENT", ...}}`

### Requirement: Agents Appear In KB Graph

The system's `GET /api/kb/graph` SHALL include each agent as a node with `source:"agent"`. Each `skills[]` reference SHALL produce a `composes` edge whose `source` is the agent and `target` is the skill node.

#### Scenario: Agent with two skills produces two composes edges

- **GIVEN** an agent `sre-bot` with `skills: [reboot-server, check-server-health]`, both skills present on disk
- **WHEN** a client sends `GET /api/kb/graph`
- **THEN** the `nodes` array contains an entry with `id:"sre-bot"` and `source:"agent"`
- **AND** the `edges` array contains exactly two entries with `kind:"composes"`, `source:"sre-bot"`, and targets `"reboot-server"` and `"check-server-health"` (in any order)

#### Scenario: Dangling skill ref in agent surfaces as a diagnostic

- **GIVEN** an agent `bad-bot` whose `skills` array references `nonexistent-skill`
- **WHEN** a client sends `GET /api/kb/graph`
- **THEN** the `diagnostics` array includes an entry with `severity:"warn"` and a message naming `nonexistent-skill`
- **AND** the `edges` array does NOT include an edge from `bad-bot` to `nonexistent-skill`

### Requirement: Update An Agent (Live Edit)

The system SHALL expose `PUT /api/agents/:name` accepting JSON `{description?, skills?, persona?}`. The handler MUST:

- Reject when `<kbRoot>/agents/<name>/AGENT.md` does not exist with `404 UNKNOWN_AGENT`.
- ALWAYS preserve the `name` frontmatter — agents cannot be renamed via PUT.
- When `skills` is provided, validate every entry references an existing skill (else `400 INVALID_AGENT_SKILLS`).
- Merge: omitted fields preserve their existing values; provided fields replace.
- Write atomically (tmp+rename in place).
- Return `200 {name, path}`.

#### Scenario: PUT replaces skills array and re-validates

- **GIVEN** an agent `bot` with `skills: [a, b]`, both skills exist
- **AND** skill `c` exists, skill `d` does not
- **WHEN** a client sends `PUT /api/agents/bot {skills: ["a", "c"]}`
- **THEN** the response status is `200` and the file's `skills` is now `["a", "c"]`
- **AND** when a client sends `PUT /api/agents/bot {skills: ["a", "d"]}`
- **THEN** the response status is `400` with code `INVALID_AGENT_SKILLS`
- **AND** the file is unchanged from the prior PUT

#### Scenario: PUT on a missing agent returns 404

- **WHEN** a client sends `PUT /api/agents/no-such {description: "x"}`
- **THEN** the response status is `404`
- **AND** the body matches `{"error":{"code":"UNKNOWN_AGENT", ...}}`
