# Delta: frontend

## ADDED Requirements

### Requirement: Single-Page Frontend

The system SHALL provide a Vite-built single-page frontend in `web/` that runs entirely from `web/dist/`. The page is browser-only — it MUST NOT depend on a server-side render or framework runtime beyond Vite's built JS.

#### Scenario: web/dist/index.html opens in any modern browser

- **GIVEN** the operator runs `cd web && npm run build`
- **WHEN** they open `web/dist/index.html` directly OR via any static server
- **THEN** the page renders without server-side dependencies
- **AND** the only network calls go to `/api/*` on a configured workspace base URL

### Requirement: Token Login Flow

The system SHALL prompt the operator for the dev token on first visit when `GET /api/auth/check` returns `401`. Successful login (cookie-issuing 200) MUST hide the prompt and reveal the chat surface.

#### Scenario: Unauthed user sees the token prompt

- **GIVEN** a fresh browser with no `workspace_session` cookie
- **WHEN** the page loads and probes `GET /api/auth/check`
- **THEN** the page shows a "Paste dev token to continue" form
- **AND** the chat pane is not visible

#### Scenario: Successful login reveals the chat surface

- **GIVEN** the operator pastes a valid token
- **WHEN** `POST /api/auth/login` returns 200
- **THEN** the chat pane is visible
- **AND** the skills sidebar starts loading via `GET /api/kb/graph`

### Requirement: Chat Pane

The system SHALL provide a `<chat-pane>` Lit component that:

- Lazily creates a session via `POST /api/sessions` on the first user submission and remembers `sessionKey`.
- Submits each prompt via `POST /api/send-stream`, then opens `GET /api/runs/:runId/events?afterSeq=0` as an `EventSource`.
- Renders streaming `assistant.delta` events into a single growing message bubble.
- Renders `tool.call.start/end` and `tool.result` as compact, collapsed-by-default panels under the assistant message.
- Closes the EventSource on `run.completed`.

#### Scenario: A prompt produces a streaming bubble

- **GIVEN** the operator is logged in and has typed "say hi"
- **WHEN** they submit
- **THEN** the chat pane shows a "user: say hi" bubble immediately
- **AND** within the next several seconds, an "assistant" bubble appears whose text grows as `assistant.delta` events arrive
- **AND** when `run.completed` is observed, the EventSource is closed

#### Scenario: A second submission while a run is active is blocked at the UI

- **GIVEN** a prompt is in flight (no `run.completed` yet)
- **WHEN** the operator tries to submit a second prompt
- **THEN** the input is disabled and a "still running…" hint is shown
- **AND** no second `POST /api/send-stream` is issued

### Requirement: Skills Sidebar

The system SHALL provide a `<skills-sidebar>` component that lists every skill returned by `GET /api/kb/graph` and re-fetches when `kb.changed` arrives on `GET /api/kb/events`.

#### Scenario: New skill appears within 1500ms of being written

- **GIVEN** the sidebar is mounted with five skills
- **WHEN** the workspace `POST /api/skills` writes a new skill
- **THEN** within 1500ms the sidebar shows six skills

### Requirement: Probe Banner

The system SHALL render a top banner reflecting the latest `GET /api/probe` response with traffic-light states for pi, Confluence, and skills count. Re-poll on `visibilitychange` to "visible".

#### Scenario: Banner reflects probe state

- **GIVEN** `GET /api/probe` returns `{pi:{ok:true}, confluence:{configured:false, ...}, skills:{count:5}}`
- **WHEN** the page loads
- **THEN** the banner shows pi=green, confluence=amber/red, skills=5

### Requirement: Hash Routing

The system SHALL support `#/` (chat) and `#/skill/<name>` (read a skill body via `GET /api/kb/skill/:name`). Routes are hash-fragment only.

#### Scenario: Navigating to a skill route loads the body

- **WHEN** the page navigates to `#/skill/reboot-server`
- **THEN** the chat pane is replaced by a panel showing the skill body rendered from markdown
- **AND** a "back to chat" link returns to `#/`

### Requirement: KB Graph

The system SHALL render a D3-force-layout SVG graph at `#/graph` with one node per skill and edges for `uses` (solid) / `link` (dashed). Clicking a node navigates to that skill's detail page. The graph SHALL re-render when the skills list changes, including when a new skill is added via `kb.changed`.

#### Scenario: Adding a skill grows the graph

- **GIVEN** the operator is on `#/graph` with N skills visible
- **WHEN** a new SKILL.md is written to disk
- **THEN** within 1500ms the graph displays N+1 nodes
- **AND** clicking the new node navigates to `#/skill/<new-name>`

### Requirement: Confluence Panel

The system SHALL render a Confluence search-and-read panel at `#/confluence` with a query input, a results list, and a reader pane that loads page content via `GET /api/confluence/page/:pageId`.

#### Scenario: Search shows hits and click loads page

- **GIVEN** the operator is on `#/confluence`
- **WHEN** they search a non-empty query
- **THEN** the results list shows zero or more hits with title and snippet
- **AND** clicking a hit fetches `GET /api/confluence/page/<id>` and renders the sanitized content
