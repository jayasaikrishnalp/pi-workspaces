# Memory Spec

## Purpose

Operator notepad. Plain-markdown files at <kbRoot>/memory/<name>.md, edited live from the workspace UI. Memory is deliberately NOT a graph node — it is operator state, not agent reasoning surface. 64 KB cap per entry, atomic upsert via PUT.

## Requirements



### Requirement: Memory Files Are Plain Markdown

The system SHALL store memory entries as plain markdown files at `<kbRoot>/memory/<name>.md`. They MUST NOT require YAML frontmatter — a memory file may be a single line of text. The file name (excluding `.md`) is the entry's logical id.

### Requirement: List Memory Files

The system SHALL expose `GET /api/memory` returning `{entries: [{name, size, mtime}]}` where `size` is byte length and `mtime` is a unix-millis timestamp. Entries are sorted by `mtime` descending so the most recently edited surfaces first.

#### Scenario: List enumerates memory files

- **GIVEN** two memory files `preferences.md` and `paged-recently.md` exist
- **WHEN** a client sends `GET /api/memory`
- **THEN** the body matches `{"entries": [{"name":"paged-recently","size":<int>,"mtime":<int>}, {"name":"preferences",...}]}` with most-recent first
- **AND** entries do NOT include a `.md` suffix in `name`

### Requirement: Read A Memory File

The system SHALL expose `GET /api/memory/:name` returning `{name, body, size, mtime}`. Name MUST match `/^[a-z][a-z0-9-]{0,63}$/`.

#### Scenario: Existing memory file is returned

- **GIVEN** `preferences.md` containing `"prefer dry-run before any reboot\n"`
- **WHEN** a client sends `GET /api/memory/preferences`
- **THEN** the response status is `200`
- **AND** `body === "prefer dry-run before any reboot\n"`

#### Scenario: Missing memory file returns 404 UNKNOWN_MEMORY

- **WHEN** a client sends `GET /api/memory/nope`
- **THEN** the response status is `404`
- **AND** the body matches `{"error":{"code":"UNKNOWN_MEMORY", ...}}`

#### Scenario: Invalid memory name on read is rejected

- **WHEN** a client sends `GET /api/memory/Bad%20Name`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"INVALID_MEMORY_NAME", ...}}`

### Requirement: Write A Memory File (Upsert)

The system SHALL expose `PUT /api/memory/:name` accepting JSON `{content: string}` and writing the body to `<kbRoot>/memory/<name>.md` atomically (tmp + rename). The file MUST be created if missing AND replaced if present (upsert). Body MUST be capped at 65_536 characters; longer payloads return `400 BODY_TOO_LARGE`.

Memory is intentionally upsert (in contrast to skills/agents/workflows which reject re-creation) — operator notes are a notepad surface, overwrite is the expected UX.

#### Scenario: PUT creates a new memory file

- **GIVEN** `<kbRoot>/memory/notes.md` does not exist
- **WHEN** a client sends `PUT /api/memory/notes {content: "first note\n"}`
- **THEN** the response status is `200` with body `{"name":"notes","size":11,"mtime":<int>}`
- **AND** `<kbRoot>/memory/notes.md` exists with content `"first note\n"`

#### Scenario: PUT replaces an existing memory file

- **GIVEN** `<kbRoot>/memory/notes.md` contains `"old\n"`
- **WHEN** a client sends `PUT /api/memory/notes {content: "new\n"}`
- **THEN** the response is `200`
- **AND** the file content is now `"new\n"` exactly

#### Scenario: PUT with body > 65_536 chars returns 400 BODY_TOO_LARGE

- **WHEN** a client sends `PUT /api/memory/big {content: "x".repeat(70_000)}`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"BODY_TOO_LARGE", ...}}`
- **AND** the file is unchanged (or absent if it didn't exist)

### Requirement: Memory Is Not A KB Graph Node

The system SHALL NOT include memory files as nodes in `GET /api/kb/graph`. Memory is operator-owned text, distinct from the entity graph (skills/agents/workflows) the agent reasons about.

#### Scenario: A memory file does not produce a kb-graph node

- **GIVEN** `<kbRoot>/memory/preferences.md` exists
- **WHEN** a client sends `GET /api/kb/graph`
- **THEN** no node in `nodes[]` has `id:"preferences"` originating from the memory file
- **AND** no diagnostic mentions `memory/preferences.md` (memory is intentionally outside the graph's responsibility)
