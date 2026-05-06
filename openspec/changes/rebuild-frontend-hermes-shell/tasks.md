# Tasks: Rebuild Frontend — Hermes-Style Sidebar Shell (8-phase)

## Phase 1 — Foundation

- [x] 1.1 Delete the existing `web/` (Lit + Tailwind) — wholesale replacement.
- [x] 1.2 Scaffold Vite + React 18 + TypeScript at `web/`. Install deps: react, react-dom, vite, @vitejs/plugin-react, typescript, vitest, @playwright/test, @testing-library/react, @testing-library/jest-dom.
- [x] 1.3 Lift `tokens.css` + `shell.css` + `sidebar.css` from /tmp/cloudops-design-v2/pi-workspaces/project/assets/.
- [x] 1.4 Build `Sidebar.tsx`, `Titlebar.tsx`, `Statusbar.tsx`, `ProbeBanner.tsx`, `Icons.tsx`.
- [x] 1.5 Build `App.tsx` with active screen state + sidebar collapse + localStorage persistence + login flow (cookie-gated /api/probe + /api/auth/login).
- [x] 1.6 Vite proxy `/api/*` → `http://localhost:8766`.
- [x] 1.7 Top-level `npm run test:web` and `npm run test:web:e2e` scripts.
- [x] 1.8 Vitest test: sidebar reducer (collapse/expand persists to localStorage).
- [x] 1.9 Playwright test (`shell.spec.ts`): page loads, login works with dev token, sidebar renders + collapses, probe banner reflects /api/probe data.
- [x] 1.10 Phase 1 commit + push.

## Phase 2 — Dashboard

- [x] 2.1 `DashboardScreen.tsx` with stat cards (skills/agents/souls/jobs/tasks/runs counts), recent jobs list, recent tasks list.
- [x] 2.2 `useProbe`, `useJobs`, `useTasks` hooks.
- [x] 2.3 Playwright `dashboard.spec.ts` — assert all stat cards render with the live counts.
- [x] 2.4 Phase 2 commit + push.

## Phase 3 — Chat

- [x] 3.1 `ChatScreen.tsx`, `Composer.tsx`, `Message.tsx`, `ToolCard.tsx`.
- [x] 3.2 `useChatStream` consuming /api/chat-events + send-stream.
- [x] 3.3 `streamingMessage.ts` reducer + Vitest unit test.
- [x] 3.4 Playwright `chat.spec.ts` — Playwright intercepts /api/sessions/*/send-stream and replays canned events; asserts streaming UI.
- [x] 3.5 Phase 3 commit + push.

## Phase 4 — Knowledge Graph

- [x] 4.1 Lift `hexgraph.jsx` math + render approach into `HexGraph.tsx` + `hexLayout.ts`.
- [x] 4.2 `useKbGraph` initial GET + SSE delta merge.
- [x] 4.3 `SkillDetail.tsx` side rail.
- [x] 4.4 Souls + embodies edges rendered.
- [x] 4.5 Vitest unit tests for `hexLayout.ts` (axial → pixel conversions).
- [x] 4.6 Playwright `graph.spec.ts` — seed kb, assert nodes render, click a node, assert detail rail opens.
- [x] 4.7 Phase 4 commit + push.

## Phase 5 — KB CRUD: Skills + Souls + Memory

- [ ] 5.1 `SkillsScreen.tsx` (list + detail + create + edit) wired to /api/skills + PUT.
- [ ] 5.2 `SoulsScreen.tsx` (list + create + edit) wired to /api/souls.
- [ ] 5.3 `MemoryScreen.tsx` (list + read + edit upsert) wired to /api/memory.
- [ ] 5.4 Playwright `kb-crud.spec.ts` — create a soul, attach to a new agent, verify the embodies edge appears in graph.
- [ ] 5.5 Phase 5 commit + push.

## Phase 6 — Jobs + Tasks + Terminal

- [ ] 6.1 `JobsScreen.tsx` list + cancel + detail.
- [ ] 6.2 `TasksScreen.tsx` kanban (columns by status) with drag-to-transition + idempotency-aware create.
- [ ] 6.3 `TerminalScreen.tsx` exec console + audit log table.
- [ ] 6.4 Vitest: tasks state-machine guard.
- [ ] 6.5 Playwright `jobs-tasks-terminal.spec.ts` — terminal exec returns stdout, task created → moved through statuses, job cancel.
- [ ] 6.6 Phase 6 commit + push.

## Phase 7 — MCP + Confluence + Settings + Overlays

- [ ] 7.1 `McpScreen.tsx` lists servers + tools, surfaces status pills, allows tool-call test.
- [ ] 7.2 `ConfluenceScreen.tsx` search + page-detail.
- [ ] 7.3 `Settings.tsx` overlay — provider switch (PUT /api/providers/active), theme picker (vibe), probe banner toggle.
- [ ] 7.4 `CommandPalette.tsx` (⌘K) + `Shortcuts.tsx` (?) + `SaveSkillModal.tsx`.
- [ ] 7.5 Playwright `overlays.spec.ts` — ⌘K opens palette, fuzzy filter works; ? opens shortcuts; settings switches vibe; provider PUT roundtrip.
- [ ] 7.6 Phase 7 commit + push.

## Phase 8 — Polish + Hero + Vibes + 4 PREVIEW screens + Smoke

- [ ] 8.1 PREVIEW screens — `SwarmScreen.tsx`, `ConductorScreen.tsx`, `OperationsScreen.tsx`, `FilesScreen.tsx` — render with mock data + PREVIEW badge per design.
- [ ] 8.2 `ToastStack.tsx` + `ParticleBurst.tsx` + save-as-skill hero animation wired through real /api/skills + kb.changed SSE.
- [ ] 8.3 4 vibes lit (terminal/sre/calm/cyber) togglable in Settings; CSS-var-only components verified by lint pass.
- [ ] 8.4 End-to-end Playwright smoke (`save-skill-hero.spec.ts`) — chat → save-skill → graph animates new hex → toast → search returns it.
- [ ] 8.5 Visual sanity hand-test against `/tmp/cloudops-design-v2` reference.
- [ ] 8.6 Phase 8 commit.

## Verification + archive

- [ ] 9.1 `npm run test:web` (Vitest) green.
- [ ] 9.2 `npm run test:web:e2e` (Playwright) green.
- [ ] 9.3 Backend suite still 253/253 green.
- [ ] 9.4 Type-check clean (`tsc --noEmit` in both root + web/).
- [ ] 9.5 Codex review — deferred sweep across all 5 changes.
- [ ] 9.6 Archive commit + push.
