# Design: Rebuild Frontend — Hermes-Style Sidebar Shell

## Approach

8-phase rebuild within one OpenSpec change. Each phase ships a working slice of the workspace. The change archives only after phase 8 lands and the full Playwright smoke passes.

| Phase | Slice | Tests |
|---|---|---|
| 1 | Vite + React + TS scaffold; tokens/shell/sidebar CSS lifted; sidebar shell renders + collapses; login flow; probe banner | Vitest: sidebar reducer; Playwright: page loads, sidebar collapses, probe banner visible |
| 2 | Dashboard (probe + counts + recent jobs + recent tasks) | Playwright: dashboard renders all stat cards from real /api/probe |
| 3 | Chat (existing chat-events SSE + run history) | Playwright: send a stub message, observe streaming response |
| 4 | Knowledge Graph (hex layout, drag/select, souls + embodies edges, skill detail) | Vitest: hexLayout math; Playwright: graph renders nodes from /api/kb/graph |
| 5 | Skills + Souls + Memory CRUD with live edit | Playwright: create a skill, observe in graph; create soul; edit memory |
| 6 | Jobs (list + cancel) + Tasks (kanban) + Terminal (exec console) | Playwright: terminal exec returns stdout; tasks state transitions |
| 7 | MCP + Confluence + Settings overlay + ⌘K palette + ? shortcuts | Playwright: ⌘K opens palette; settings opens; vibe toggle works |
| 8 | Polish: save-as-skill hero animation, toasts, the 4 vibes lit, end-to-end smoke | Playwright: full chat → save-skill → graph-update flow |

## Architecture

```
web/
├── index.html                  # mounts #root, no inline scripts
├── vite.config.ts              # proxy /api → localhost:8766
├── tsconfig.json
├── package.json
├── playwright.config.ts        # boots backend + vite preview, opens chromium
├── test/
│   ├── unit/                   # Vitest
│   │   ├── hexLayout.test.ts
│   │   ├── streamingMessage.test.ts
│   │   ├── commandPaletteFilter.test.ts
│   │   └── statusReducers.test.ts
│   ├── e2e/                    # Playwright
│   │   ├── _fixtures.ts        # boots backend on a free port + tmp workspace dir
│   │   ├── shell.spec.ts       # Phase 1
│   │   ├── dashboard.spec.ts   # Phase 2
│   │   ├── chat.spec.ts        # Phase 3
│   │   ├── graph.spec.ts       # Phase 4
│   │   ├── kb-crud.spec.ts     # Phase 5
│   │   ├── jobs-tasks-terminal.spec.ts # Phase 6
│   │   ├── overlays.spec.ts    # Phase 7
│   │   └── save-skill-hero.spec.ts # Phase 8
│   └── setup.ts                # @testing-library/jest-dom matchers
├── public/
│   └── kodekloud-logo.svg      # from design bundle
└── src/
    ├── main.tsx                # ReactDOM.createRoot, theme provider
    ├── App.tsx                 # active screen + sidebar collapse + hotkeys + overlay state
    ├── styles/
    │   ├── tokens.css          # ← lifted from design (the swap-point)
    │   ├── shell.css           # ← lifted from design (incl. 4 vibes)
    │   └── sidebar.css         # ← lifted from design
    ├── lib/
    │   ├── api.ts              # typed fetch clients per backend route
    │   ├── sse.ts              # EventSource wrapper with backoff
    │   ├── hexLayout.ts        # axial coordinate math
    │   ├── streamingMessage.ts # reducer for chat tool-card streams
    │   └── ftsHighlight.ts     # parse <<>> markers from /api/search snippets
    ├── hooks/
    │   ├── useApi.ts
    │   ├── useSse.ts
    │   ├── useProbe.ts
    │   ├── useKbGraph.ts
    │   ├── useChatStream.ts
    │   ├── useJobs.ts
    │   ├── useTasks.ts
    │   ├── useTerminal.ts
    │   ├── useProviders.ts
    │   ├── useMcp.ts
    │   ├── useSouls.ts
    │   ├── useSearch.ts
    │   └── useHotkeys.ts
    ├── components/
    │   ├── Sidebar.tsx          # MAIN + KNOWLEDGE + SESSIONS groups
    │   ├── icons/Icons.tsx
    │   ├── shell/
    │   │   ├── Titlebar.tsx
    │   │   ├── Statusbar.tsx
    │   │   └── ProbeBanner.tsx
    │   ├── screens/
    │   │   ├── DashboardScreen.tsx
    │   │   ├── ChatScreen.tsx
    │   │   ├── GraphScreen.tsx
    │   │   ├── SkillsScreen.tsx
    │   │   ├── SoulsScreen.tsx
    │   │   ├── MemoryScreen.tsx
    │   │   ├── ConfluenceScreen.tsx
    │   │   ├── McpScreen.tsx
    │   │   ├── JobsScreen.tsx
    │   │   ├── TasksScreen.tsx
    │   │   ├── TerminalScreen.tsx
    │   │   ├── SessionsScreen.tsx
    │   │   └── PreviewScreen.tsx  # Swarm/Conductor/Operations/Files
    │   ├── chat/
    │   │   ├── Composer.tsx
    │   │   ├── Message.tsx
    │   │   └── ToolCard.tsx
    │   ├── graph/
    │   │   ├── HexGraph.tsx
    │   │   └── SkillDetail.tsx
    │   └── overlays/
    │       ├── CommandPalette.tsx
    │       ├── Shortcuts.tsx
    │       ├── Settings.tsx
    │       ├── SaveSkillModal.tsx
    │       ├── ToastStack.tsx
    │       └── ParticleBurst.tsx
    └── types/
        └── api.ts              # mirrors backend response shapes (souls, jobs, tasks, terminal, mcp, etc.)
```

## Data flow

- Each tab is self-contained. Active tab + sidebar-collapsed-bool live in `App.tsx` `useState` (persisted to `localStorage`).
- `useSse` opens `EventSource`, runs an exponential-backoff reconnect (1s → 2s → 4s → 8s, capped). Heartbeat events reset the backoff timer.
- `useChatStream` opens `/api/chat-events`, reduces incoming events through `streamingMessage.ts`, exposes a stable `messages[]` array.
- `useKbGraph` does an initial `GET /api/kb/graph`, then merges `/api/kb/events` deltas. Same shape feeds GraphScreen + ContextRail mini-graph.
- Login: `POST /api/auth/login`. `useApi` retries once with login redirect on `401`.

## Test harness

**Vitest** (`web/test/unit/*.test.ts`):
- Pure functions: hex layout math, FTS snippet parser, streaming reducer.
- Component logic with @testing-library/react where it adds value (e.g. command palette filter).

**Playwright** (`web/test/e2e/*.spec.ts`):
- `_fixtures.ts` boots the backend on a random free port with a tmp workspace dir and a tmp `.pi-workspace`. Each test gets a fresh backend.
- The frontend runs from `vite preview` against the production build (deterministic, no HMR flake).
- Tests open chromium, navigate to `http://localhost:<vite-port>/`, perform real DOM operations, assert via `expect(page.locator(...)).toBe...`.
- The default workflow per phase: write a spec.ts that fails first, implement until it passes, commit.

## Decisions

- **Decision:** React + Vite + TS, no SSR/router/state-lib.
  **Why:** User answered. Single-window SPA with internal tab state. `useState` + custom hooks scale to this size.

- **Decision:** Lift the design's `tokens.css` + `shell.css` + `sidebar.css` verbatim. No Tailwind.
  **Why:** Design ships a complete CSS system. Re-deriving Tailwind would double work without behavioral gain.

- **Decision:** Vibes are CSS class swaps on the body element (`vibe-terminal`, `vibe-sre`, `vibe-calm`, `vibe-cyber` + default). Components reference CSS variables, never literals.
  **Why:** Existing design pattern. A future third-party token swap drops in cleanly.

- **Decision:** Playwright per-phase, not Cypress / WebdriverIO.
  **Why:** Playwright's `expect(locator)` auto-retries DOM queries — cuts flake. Solo binary install. Built-in HAR / video on failure for debugging.

- **Decision:** Each E2E test boots its own backend process with a tmp workspace.
  **Why:** True isolation. No flaky state leakage between tests. Boot is ~1.5s; acceptable for ~10 specs.

- **Decision:** "PREVIEW" badge on the 4 unwired screens (Swarm/Conductor/Operations/Files).
  **Why:** User chose option (a) — full visual fidelity, stub the empty screens. Badge is honest. Backends land as follow-ups.

- **Decision:** No real pi process required for chat E2E.
  **Why:** Playwright stubs the bridge by intercepting `/api/sessions/*/send-stream` and replaying canned events. The backend's pi-rpc-bridge has no opinion about whether pi is real or stubbed; tests assert the UI, not the agent.

- **Decision:** Per-screen test file (one Playwright spec per phase).
  **Why:** Test failures point at the phase that broke; fast iteration.

## Risks & mitigations

- **Backend boot in tests is slow.** → ~1.5s per spec. Use `test.beforeAll` per file (not `beforeEach`) where state isolation isn't needed. Total E2E suite under 60s on M1.
- **Playwright CDP-detection on Linux CI.** → `npx playwright install chromium` in CI; document in CONTRIBUTING.
- **CSS-variable cascade leaks across vibes.** → Vibes scope to `body.vibe-*`; tokens.css default applies otherwise.
- **HMR breaks `web/test/e2e` flakiness.** → E2E always runs against `vite preview` (production build), not `vite dev`.
- **Save-as-skill hero animation flake on slow machines.** → CSS-only keyframes, no React state per frame. Tested on M1 baseline.
- **`useSse` reconnect storms.** → Exponential backoff 1s → 8s capped, with reset on every received heartbeat.
