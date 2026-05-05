# CloudOps Workspace

> An SRE command center wrapping the `pi` agent CLI for Wolters Kluwer CloudOps. Single browser tab: chat with an AI that knows your runbooks, watch its knowledge grow as it learns from Confluence, save what you learned as permanent skills.

**Status:** Phase 1 complete — Stages 0–11 shipped (~22h roadmap delivered). Backend spans `pi-rpc` bridge with replay-aware SSE, run cancellation, KB watcher + graph, hardened Confluence integration, skill creation, cookie auth + capability probe. Frontend (Vite + Lit + Tailwind v4) ships chat, skills sidebar, D3 graph, and Confluence search. Phase 2 (workflow engine) committed but not yet started.

## Quick start

```bash
bash start.sh
# Backend on http://127.0.0.1:8766
# Frontend on http://127.0.0.1:5173 (Vite proxies /api → backend)
# Token printed to stdout; paste into the workspace login.
```

## 7-step demo (per locked spec)

1. **Open the browser** to `http://127.0.0.1:5173/`. Paste the dev token.
2. **The skills sidebar** shows the 5 seed skills (`reboot-server`, `check-server-health`, `patch-vm`, `disk-cleanup`, `aws-cleanup`).
3. **Click "graph"** — D3 force layout shows the seed skills + the `uses` edge from `reboot-server` → `check-server-health`.
4. **Click "chat"** and ask a question pi can answer from the seed skills, e.g., "How do I reboot a server safely?". Watch the SSE stream paint the answer.
5. **Click "confluence"**, search for a runbook ("CloudOps SDK"). Pick a result; the reader pane shows the sanitized body wrapped in `<external_content trusted="false">…</external_content>` markers.
6. **Save what you learned as a skill** by `POST /api/skills` (or paste from the chat — frontend "save as skill" button is a Phase 3 enhancement). Watch the skill appear in the sidebar AND animate into the graph within 1500ms.
7. **Re-ask the original question.** This time the agent hits the new skill (no Confluence call). Knowledge that compounds.

## Repo layout

| Path | What lives there |
|---|---|
| `mission.md`, `roadmap.md`, `technical-stack.md` | Phase plan + decisions |
| `cloudops-workspace-spec.md` | Locked v3 build spec (Codex-approved) |
| `openspec/specs/**` | Source-of-truth specs per domain |
| `openspec/changes/archive/**` | Every shipped change as it landed |
| `src/` | Backend Node 22 + TypeScript |
| `web/` | Frontend Vite + Lit + Tailwind v4 |
| `seed-skills/` | Demo seed knowledge |
| `tests/` | `npm test:all` runs unit + smoke + integration |
| `review/` | Per-stage markdown + PDF review bundles (gitignored) |

## Tests

```bash
npm run test:unit          # ~85 unit tests
npm run test:smoke         # 9 stage-0 smoke
npm run test:integration   # Real-pi integration (needs pi installed; skips Confluence-live unless ATLASSIAN_API_TOKEN is set)
npm run test:all           # everything
```

Frontend currently relies on functional smoke against a running backend; visual quality is human-verified at this stage. Stage 11 polish.

---

## How to navigate this repository

This project uses [OpenSpec](https://github.com/Fission-AI/OpenSpec) conventions for spec-driven development. Read the docs in this order:

| Doc | Purpose | Read first if |
|---|---|---|
| **[`mission.md`](./mission.md)** | Product vision, target user, differentiators | You're new — start here |
| **[`roadmap.md`](./roadmap.md)** | Phased plan, 12 stages, sequencing | You want the build plan |
| **[`technical-stack.md`](./technical-stack.md)** | Stack choices, key decisions | You're picking up implementation |
| **[`cloudops-workspace-spec.md`](./cloudops-workspace-spec.md)** | The locked v3 build spec — Codex-approved | You're implementing a stage |
| **[`openspec/AGENTS.md`](./openspec/AGENTS.md)** | Rules for AI agents touching this repo | You ARE an AI agent |
| **[`openspec/changes/`](./openspec/changes/)** | In-flight proposals + delta specs | You want to know what's being built right now |
| **[`openspec/specs/`](./openspec/specs/)** | Source-of-truth behavior specs | You want to know what the system does today (currently empty — populated on first archive) |

## Provenance

This project is the implementation phase of the work documented in `~/research-folder/`:

- 5 working spikes (`cloudops-spikes/`) validated every integration risk
- `hermes-workspace-architecture.md` — reference architecture (1406 lines)
- `cobra-and-wk-ghcos-analysis.md` — enterprise context for WK COBRA
- `pi-zero-to-hero.md` — pi internals deep dive
- `cloudops-workspace-spec.md` (this repo) — the locked v3 build spec, after 3 rounds of Codex review

## Audience

The hero user is the WK CloudOps SRE on call at 2am. Every design decision should make their life faster at that moment. See `mission.md`.

## License

Internal Wolters Kluwer prototype. Not for external distribution at this time.
