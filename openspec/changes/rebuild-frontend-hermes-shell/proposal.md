# Proposal: Rebuild Frontend — Hermes-Style Sidebar Shell (v2 Design)

## Why

The existing `web/` (Lit + Tailwind, ~350 LOC) was a Phase-1 sketch. The user's v2 design from Anthropic Design Studio (`/tmp/cloudops-design-v2`) is a substantially richer Hermes-inspired sidebar shell: collapsible left sidebar with MAIN + KNOWLEDGE + SESSIONS groups, Dashboard with stat cards + sparklines + sessions intelligence, hex-grid Knowledge Graph, Chat with tool cards, Souls/Jobs/Tasks/Terminal screens, MCP, Confluence, Settings overlay, ⌘K command palette, ? shortcuts, save-as-skill hero animation, 4 visual vibes.

Now that all 4 backend changes have shipped (agents/workflows/memory, MCP, SQLite/FTS5/souls/jobs/tasks, terminal), every screen the design needs has a real backend to read from. We rebuild `web/` from scratch in React + Vite + TypeScript, pixel-port the design, wire each screen to live data, and **test every UI change with both Vitest unit tests and a Playwright browser harness** — same structured discipline as the backend.

## What changes

- **Delete `web/`** (the Lit prototype) and replace with a fresh React 18 + Vite + TypeScript app at `web/`.
- **Visual layer:** `tokens.css` + `shell.css` + `sidebar.css` lifted verbatim from v2 design bundle; component-level CSS Modules where needed. Hex literals never appear in component code — only `var(--accent)` etc. so a future tokens.css swap (third-party design) replaces visual identity without component rewrites.
- **15 screens:** Dashboard, Chat, Files, Terminal, Jobs, Tasks, Conductor, Operations, Swarm + Knowledge Graph, Memory, Skills, Confluence, MCP, Souls (replacing v2's "Profiles") + Sessions browser. **11 wired to live data**, **4 ship as PREVIEW stubs** (Swarm, Conductor, Operations, Files — backend concepts not yet shipped).
- **4 overlays:** Command palette (⌘K), Shortcuts (?), Settings (⌘,), Save-skill modal. Toast stack + particle-burst hero animation.
- **All 4 vibes lit** (terminal / SRE / calm / cyber), togglable via the Settings overlay's Theme picker.
- **Live data from day one** — every wired screen reads from existing backend endpoints. No seed-only intermediate.
- **Browser test harness via Playwright** — every phase ships with at least one E2E test that boots the backend in a child process, opens the browser to the app, exercises the screen, and asserts visible behavior. Vitest covers component-local logic (hex layout math, streaming reducer, state machines).
- **Phased delivery within one change** — 8 phased commits. Each phase is independently demoable + tested. Archive after phase 8.

## Scope

**In scope**
- Wholesale `web/` replacement (deps, src, vite config, tsconfig).
- React 18 + Vite + TS. No Tailwind in v1 — design's CSS already complete.
- 11 wired screens + 4 PREVIEW stubs + 4 overlays.
- Vitest unit tests in `web/test/unit/`.
- Playwright E2E tests in `web/test/e2e/` with a fixture that boots the backend.
- All 4 vibes shipped + togglable.
- Save-as-skill hero (POST /api/skills → kb.changed SSE → animated hex node).

**Out of scope**
- Mobile / responsive breakpoints (desktop only).
- Multi-model chat composer + tool-approval gating UI (consumes the deferred `add-chat-controls-multi-model` change).
- E2E test against a live pi process (Playwright stubs the bridge).
- Backend stubs for Swarm / Conductor / Operations / Files — these screens render with mock data and a PREVIEW badge; backends land as follow-ups.
- Visual regression testing (screenshot diffs) — defer; Playwright DOM assertions cover behavior.

## Impact

- Affected specs: `frontend` (heavily MODIFIED — replaces the existing tiny spec with a structural-shell spec).
- Affected code: `web/**` rewritten end-to-end.
- New deps in `web/`: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `vitest`, `@playwright/test`, `@testing-library/react`, `@testing-library/jest-dom`. Removed: `lit`, `tailwindcss`, `@tailwindcss/vite`, the d3 cluster, `marked`.
- `start.sh` keeps working unchanged — the new `web/` package keeps the same `npm run dev` script contract on port 5173 with `/api/*` proxied to `localhost:8766`.
- New `npm run test:web` and `npm run test:web:e2e` scripts at the repo root.
- Risk: medium-high. Wholesale rewrite of a working frontend; if regressions land on chat/graph/Confluence flows, the workspace becomes unusable. Mitigations: per-phase Playwright smoke before commit; backend tests stay green throughout (only `web/` changes).
- Migration: no data migration. Backend untouched.
