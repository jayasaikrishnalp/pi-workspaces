# Delta: workflows

## ADDED Requirements

### Requirement: Create A Workflow

The system SHALL expose `POST /api/workflows` accepting JSON `{name: string, description?: string, steps: Array<{kind: "skill"|"workflow", ref: string}>}`. The handler MUST:

- Reject `name` not matching `/^[a-z][a-z0-9-]{0,63}$/` with `400 INVALID_WORKFLOW_NAME`.
- Reject when `steps` is missing, empty, or contains entries that aren't `{kind, ref}` pairs with `400 INVALID_WORKFLOW_STEPS`.
- Reject when any `steps[].ref` does not match a corresponding existing entity (skill if `kind:"skill"`, workflow if `kind:"workflow"`) with `400 INVALID_WORKFLOW_STEPS` and a diagnostic listing the missing refs.
- Reject when `<kbRoot>/workflows/<name>/WORKFLOW.md` already exists with `409 WORKFLOW_EXISTS`.
- Write WORKFLOW.md atomically. The frontmatter MUST contain `name`, `steps` (rendered as a block array of `{kind, ref}` tagged objects — see notes), and optionally `description`.
- Return `201 {name, path}`.

> Frontmatter rendering of `steps`: the simple-YAML parser used in this project supports scalars and string arrays only. Steps are stored as a string array of `"<kind>:<ref>"` (e.g. `"skill:reboot-server"`); the writer joins with `:` and the reader splits on the first `:`. This keeps the parser surface small.

#### Scenario: Valid POST creates a workflow

- **GIVEN** skills `reboot-server` and `check-server-health` exist
- **WHEN** a client sends `POST /api/workflows {name:"safe-reboot", steps:[{kind:"skill",ref:"check-server-health"},{kind:"skill",ref:"reboot-server"}]}`
- **THEN** the response status is `201`
- **AND** `<kbRoot>/workflows/safe-reboot/WORKFLOW.md` parses with `name: safe-reboot` and `steps` as the two-element string array `["skill:check-server-health","skill:reboot-server"]` (order preserved)

#### Scenario: Step ref to a missing skill is rejected

- **WHEN** a client sends `POST /api/workflows {name:"x", steps:[{kind:"skill", ref:"nonexistent"}]}`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"INVALID_WORKFLOW_STEPS","details":{"missing":[{"kind":"skill","ref":"nonexistent"}]}, ...}}`
- **AND** no file is created

#### Scenario: Empty steps array is rejected

- **WHEN** a client sends `POST /api/workflows {name:"x", steps:[]}`
- **THEN** the response status is `400`

#### Scenario: Workflow already exists returns 409

- **GIVEN** `<kbRoot>/workflows/dup/WORKFLOW.md` exists
- **WHEN** a client sends `POST /api/workflows {name:"dup", steps:[{kind:"skill",ref:"reboot-server"}]}`
- **THEN** the response status is `409`

### Requirement: List Workflows

The system SHALL expose `GET /api/workflows` returning `{workflows: [{name, description?, steps[]}]}` for every parsable WORKFLOW.md.

#### Scenario: List enumerates all workflows

- **GIVEN** two parseable workflows `w1` and `w2` on disk
- **WHEN** a client sends `GET /api/workflows`
- **THEN** the body's `workflows` array contains both names

### Requirement: Read A Workflow

The system SHALL expose `GET /api/workflows/:name` returning `{name, frontmatter, body, path}`.

#### Scenario: Existing workflow returns parsed steps

- **GIVEN** `safe-reboot` on disk with two `skill:` steps
- **WHEN** a client sends `GET /api/workflows/safe-reboot`
- **THEN** the response is `200` and `frontmatter.steps` is the string array of `"<kind>:<ref>"` entries

#### Scenario: Missing workflow returns 404 UNKNOWN_WORKFLOW

- **WHEN** a client sends `GET /api/workflows/nope`
- **THEN** the response status is `404`
- **AND** the body matches `{"error":{"code":"UNKNOWN_WORKFLOW", ...}}`

### Requirement: Workflows Appear In KB Graph

The system's `GET /api/kb/graph` SHALL include each workflow as a node with `source:"workflow"`. Each step SHALL produce a `step` edge from the workflow node to the referenced skill or workflow node.

#### Scenario: Workflow with two skill steps produces two step edges

- **GIVEN** `safe-reboot` with steps `skill:check-server-health` then `skill:reboot-server`
- **WHEN** a client sends `GET /api/kb/graph`
- **THEN** `nodes` includes an entry with `id:"safe-reboot"` and `source:"workflow"`
- **AND** `edges` includes two entries with `kind:"step"` from `safe-reboot` to each skill (in step order or any order — this is a graph, not a sequence)

#### Scenario: Dangling step ref in workflow surfaces as a diagnostic

- **GIVEN** a workflow whose steps reference a skill that no longer exists
- **WHEN** the graph is built
- **THEN** the diagnostics include a `severity:"warn"` entry naming the missing ref
- **AND** the dangling-step edge is NOT emitted

### Requirement: Update A Workflow (Live Edit)

The system SHALL expose `PUT /api/workflows/:name` accepting JSON `{description?, steps?}`. The handler MUST:

- Reject when `<kbRoot>/workflows/<name>/WORKFLOW.md` does not exist with `404 UNKNOWN_WORKFLOW`.
- ALWAYS preserve the `name` frontmatter.
- When `steps` is provided, re-validate every `{kind, ref}` entry against the corresponding existing entity (skill or workflow); reject with `400 INVALID_WORKFLOW_STEPS` if any are missing.
- Write atomically (tmp+rename in place).
- Return `200 {name, path}`.

#### Scenario: PUT updates steps and re-validates

- **GIVEN** a workflow `safe-reboot` with `steps:["skill:check-server-health","skill:reboot-server"]`
- **WHEN** a client sends `PUT /api/workflows/safe-reboot {steps:[{kind:"skill",ref:"check-server-health"}]}`
- **THEN** the response is `200` and the file's `steps` is now the single-element string array `["skill:check-server-health"]`

#### Scenario: PUT with a dangling step ref returns 400

- **GIVEN** a workflow `safe-reboot` exists
- **WHEN** a client sends `PUT /api/workflows/safe-reboot {steps:[{kind:"skill",ref:"ghost"}]}`
- **THEN** the response is `400` with code `INVALID_WORKFLOW_STEPS`
- **AND** the file is unchanged

#### Scenario: PUT on a missing workflow returns 404

- **WHEN** a client sends `PUT /api/workflows/no-such {description:"x"}`
- **THEN** the response is `404`
- **AND** the body matches `{"error":{"code":"UNKNOWN_WORKFLOW", ...}}`
