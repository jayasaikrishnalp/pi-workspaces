# Delta: frontend

## MODIFIED Requirements

### Requirement: Workspace Shell Layout

The web frontend SHALL render a Hermes-style sidebar shell:

- A 36px titlebar with crumbs, ⌘K search button, bell, help, settings.
- A collapsible left sidebar (default 220px wide, collapsed 52px) with three groups: MAIN (Dashboard / Chat / Files / Terminal / Jobs / Tasks / Conductor / Operations / Swarm), KNOWLEDGE (Graph / Memory / Skills / Confluence / MCP / Souls), SESSIONS (recent + "All sessions →"). Footer holds the user pill + settings/theme icon buttons.
- A main content area that swaps screens based on the sidebar selection.
- A 24px statusbar showing model, counts (skills, runs), heartbeat, version.

The active screen, sidebar-collapsed bool, and current vibe MUST persist to `localStorage` so reloads restore state.

#### Scenario: Sidebar collapses on click

- **GIVEN** the workspace is open and the sidebar is in its default expanded state
- **WHEN** the user clicks the collapse button
- **THEN** the sidebar shrinks to its icon-only width
- **AND** localStorage records the new collapsed state
- **AND** reloading the page restores the collapsed state

#### Scenario: Selecting a sidebar item swaps the main content

- **GIVEN** the workspace is on Dashboard
- **WHEN** the user clicks the "Chat" item in MAIN
- **THEN** the chat screen replaces the dashboard
- **AND** the sidebar's "Chat" item gets the active style

### Requirement: Live Probe Banner

The system SHALL display a probe banner above the main content (toggleable in Settings) that surfaces the workspace health from `GET /api/probe`. Fields shown: pi (ok + version + active model), confluence (configured), mcp (per-server status pill), counts (skills / agents / souls / jobs).

#### Scenario: Probe banner reflects backend probe data

- **GIVEN** the backend reports `pi.ok=true`, `pi.version="0.73.0"`, `confluence.configured=true`, `souls.count=3`
- **WHEN** the user opens the workspace
- **THEN** the probe banner shows `pi 0.73.0 ✓`, `confluence ✓`, `souls 3`
- **AND** the underlying GET /api/probe was made exactly once on initial render

### Requirement: 15 Screens, 11 Wired + 4 Preview Stubs

The shell SHALL include 15 screens. 11 of them MUST render live data:

- Dashboard (probe + counts + recent jobs + recent tasks)
- Chat (sessions + send-stream + chat-events)
- Knowledge Graph (kb/graph + kb/events)
- Memory (CRUD via /api/memory)
- Skills (CRUD via /api/skills)
- Souls (CRUD via /api/souls)
- Confluence (search + page)
- MCP (servers + tools)
- Jobs (list + cancel)
- Tasks (kanban CRUD)
- Terminal (exec + audit log)
- Sessions (list + active-run)

4 screens MUST render with hardcoded mock data plus a "PREVIEW" badge:

- Swarm, Conductor, Operations, Files

#### Scenario: Wired screen renders live data

- **GIVEN** the backend has 5 souls in `<kbRoot>/souls/`
- **WHEN** the user navigates to the Souls screen
- **THEN** the screen lists exactly those 5 souls
- **AND** each entry shows the soul's name and description from its frontmatter

#### Scenario: Preview screen surfaces a "PREVIEW" badge

- **WHEN** the user navigates to the Swarm screen
- **THEN** the screen renders with mock data
- **AND** a PREVIEW badge is visible in the page header

### Requirement: Command Palette And Shortcuts Overlay

The system SHALL expose `⌘K` to open a command palette that fuzzy-filters across screen names + a slice of FTS5 search hits, and `?` to open a keyboard shortcuts reference overlay. Both close on Escape.

#### Scenario: ⌘K opens the palette

- **GIVEN** the user is on the Dashboard
- **WHEN** the user presses `⌘K` (or `Ctrl+K` on non-Mac)
- **THEN** the command palette opens with focus on the input
- **AND** typing "skills" shows a "Go to Skills" entry

### Requirement: Save-As-Skill Hero Animation

When the user clicks "Save as skill" on a chat message, the system SHALL:

1. Open the SaveSkillModal pre-filled with a candidate name + body.
2. On confirm, `POST /api/skills` with the content.
3. On 201, switch to the Knowledge Graph screen.
4. Subscribe to `/api/kb/events`; on the matching `add` event, render the new hex with a `hex-pop` keyframe animation and a particle burst at the screen position.
5. Show a toast: "Skill saved · `<name>` written to `<path>`".

#### Scenario: Save-as-skill end-to-end

- **GIVEN** a chat message with a "Save as skill" button
- **WHEN** the user clicks it, fills the modal with name "test-skill", and confirms
- **THEN** within ~2 seconds the user sees the Graph screen with a new hex labeled "test-skill"
- **AND** a toast banner is visible
- **AND** `GET /api/skills` shows the new skill

### Requirement: 4 Vibes Plus Default

The system SHALL ship 5 visual vibes — default ("on-system" KodeKloud blue), terminal (CRT phosphor), sre (Datadog-ish), calm (high-whitespace), cyber (HUD). The Settings overlay's Theme picker MUST switch the active vibe by toggling a `vibe-*` class on the body element. Components MUST NOT use hex literals; styling references CSS variables only so the third-party token swap requires no component changes.

#### Scenario: Switching vibe applies new tokens immediately

- **GIVEN** the workspace is in default vibe
- **WHEN** the user opens Settings → Theme → "terminal"
- **THEN** the body has class `vibe-terminal`
- **AND** the accent color visibly switches to phosphor green

### Requirement: Browser Test Harness

The frontend SHALL ship Playwright E2E tests covering each phase's critical flow. Tests boot the backend in a child process pointing at a tmp workspace dir, open chromium, exercise the UI, and assert via DOM locators. Vitest covers component-local logic (reducers, hex-layout math, parsers).

#### Scenario: Phase test suite is wired into npm

- **WHEN** a developer runs `npm run test:web`
- **THEN** Vitest runs all `web/test/unit/*.test.ts` and reports pass/fail counts

#### Scenario: E2E suite runs deterministically

- **WHEN** a developer runs `npm run test:web:e2e`
- **THEN** Playwright launches chromium, runs all `web/test/e2e/*.spec.ts`, each booting its own backend
- **AND** the suite completes in under 90 seconds on a baseline M1
