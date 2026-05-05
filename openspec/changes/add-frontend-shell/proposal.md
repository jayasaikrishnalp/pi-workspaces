# Proposal: Frontend Shell + Chat

## Why

Stages 0–7 give us a complete backend the frontend can talk to. Stage 8 ships the minimal browser experience an SRE actually opens at 2am: a single page that shows pi's chat in real time, with a sidebar for skills and a status bar for the capability probe. No persistent login UI yet beyond a token-paste box; no graph yet (Stage 9); no Confluence panel yet (Stage 10). Just the chat spine + the surrounding chrome that makes it usable.

## What changes

- New `web/` Vite + Lit + Tailwind v4 frontend (per `technical-stack.md`).
- Routes via hash fragments only — no router dependency.
- Three durable surfaces:
  - **Chat pane** wired to `POST /api/sessions` (lazy on first send), `POST /api/send-stream`, and `GET /api/runs/:runId/events` for replay-aware live streaming.
  - **Skills sidebar** loads `GET /api/kb/graph` and re-fetches on `kb.changed` (subscribed via `GET /api/kb/events`). Click-through uses `GET /api/kb/skill/:name` to show the body.
  - **Probe banner** at top renders the `GET /api/probe` matrix (pi/Confluence/skills/auth.json) with traffic-light dots. Re-polled on visibility change.
- Auth: a tiny "Paste dev token" prompt on first visit, calls `POST /api/auth/login`. Cookie is HttpOnly so the frontend never reads it directly; `GET /api/auth/check` is the readiness probe.
- Markdown rendering via `marked` (per stack); no syntax highlighter to keep it light.
- Build artifacts go to `web/dist/`. The Node server doesn't serve them yet — the operator can `npx vite preview` for a live demo, or `npx serve web/dist` from any static server. Stage 11's `start.sh` will wire this up.

## Scope

**In scope**
- Vite + Lit web component setup, Tailwind v4, marked.
- Three components: `<chat-pane>`, `<skills-sidebar>`, `<probe-banner>`.
- Hash routing: `#/`, `#/skill/<name>`.
- A `pi-store.ts` zustand-style mini-store that owns the active sessionKey, the current run's events, and the skills list.
- A static fixture-driven test that mounts each component against a recorded backend response and asserts the rendered text/HTML structure (no real backend touch).
- A live functional smoke run via the `gstack` headless browser harness when the workspace backend is up: load `/`, paste token, send a prompt, watch SSE events arrive in the DOM. Stored as a screenshot + log.

**Out of scope**
- The KB graph component itself — Stage 9.
- The Confluence panel — Stage 10.
- Full keyboard shortcut set, accessibility polish — Stage 11.
- Mobile-responsive design.
- A persisted dev-token UI flow that survives reload (we accept the operator pasting it once per session for MVP).

## Impact

- Affected specs: `frontend` (new domain).
- Affected code: `web/` (new directory tree), no changes to `src/` server code.
- New deps in `web/package.json`: `vite`, `lit`, `tailwindcss@4`, `marked`. Server's `package.json` is untouched.
- Risk level: low. The frontend is replaceable; if a component is broken it doesn't break the backend's tests.
