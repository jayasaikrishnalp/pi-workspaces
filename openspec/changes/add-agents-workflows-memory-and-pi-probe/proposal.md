# Proposal: Agents + Workflows + Memory + Providers + a Real Pi Probe

## Why

The Phase-1-as-shipped frontend is a sketch — chat + skills + Confluence + a graph. Hermes-workspace (the reference architecture, see `~/research-folder/hermes-workspace-architecture.md` §14, §18) carries far more: a real WorkspaceShell with sidebar nav, a dashboard, a memory editor, agents, sessions, and a Settings screen with provider configuration. Before any frontend rebuild can match that bar, the BACKEND must expose the data those screens read.

Four new domains are missing today:

- **agents** — a named composition of skills with an optional persona description. An agent is what the operator points at a problem ("use my CloudOps SRE agent for this"). Stored as `.pi/agents/<name>/AGENT.md`. The frontend's Agents screen lists/creates them.
- **workflows** — a named, durable plan composed of skills + decisions. Pulled forward partially from Phase 2 Stage 12, but only as a first-class data structure (storage + listing + reading); the agent-spawned-sub-agents authoring path stays Phase 2. Stored as `.pi/workflows/<name>/WORKFLOW.md`.
- **memory** — operator-owned markdown that the agent reads as context (preferences, paged-recently lists, recurring state). Stored as `.pi/memory/*.md`. The frontend's Memory screen edits these.
- **providers** — read pi's existing model registry + auth state, expose it via HTTP, let the frontend Settings screen configure the active provider/model. Powers the hermes-style "Model & Provider" page (Anthropic / OpenAI Codex via OAuth / OpenRouter / Ollama / etc).

A second, smaller item: the current `/api/probe` reports `pi.ok` as `auth.json present?`. That's a proxy, not a probe. The frontend deserves to know whether pi actually runs (version + measured latency), so we replace the heuristic with a real spawn-`pi --version` round trip with a tight timeout.

Together these are the prerequisite the hermes-caliber frontend rebuild (Change 2: `rebuild-frontend-hermes-shell`) will read against.

## What changes

- New `agents` domain
  - `.pi/agents/<name>/AGENT.md` with strict frontmatter: `name` (required), `description?`, `skills` (string[] of skill ids — required), `persona?` (a short string).
  - `GET /api/agents` lists.
  - `POST /api/agents {name, description?, skills, persona?}` creates atomically (mkdir-as-reservation, tmp+rename), validates name regex, validates that every `skills` entry references an existing skill (else `400 INVALID_AGENT_SKILLS`).
  - `GET /api/agents/:name` reads back as JSON.
  - kb-watcher already watches `.pi/`; we widen its scope so chokidar produces `kb.changed` events for agents too.
- New `workflows` domain
  - `.pi/workflows/<name>/WORKFLOW.md` with frontmatter: `name`, `description?`, `steps` (array of `{kind: "skill"|"workflow", ref: string}` objects — required, ≥1).
  - `GET /api/workflows` lists, `POST /api/workflows` creates, `GET /api/workflows/:name` reads.
  - Step refs are validated against existing skills/workflows.
- New `memory` domain
  - `.pi/memory/*.md` plain markdown files (no frontmatter required).
  - `GET /api/memory` lists files (just names + size + mtime).
  - `GET /api/memory/:name` reads body.
  - `PUT /api/memory/:name {content}` writes atomically; creates the file if missing.
- New `providers` domain
  - `GET /api/providers` returns pi's model registry plus per-provider configuration status:
    - OAuth providers (`github-copilot`) check `~/.pi/agent/auth.json`
    - Key providers (`anthropic`, `openai`, `openrouter`, `google`, `x-ai`, `deepseek`) check the env var pi reads
    - Local providers (`ollama`) probe `http://localhost:11434/api/tags` with a 1s timeout
  - `GET /api/providers/active` returns the active `{providerId, modelId}` from `~/.pi/agent/settings.json`.
  - `PUT /api/providers/active {providerId, modelId}` validates against listed providers/models and writes pi's settings.json atomically.
- Extended `kb` graph
  - `buildGraph()` walks `.pi/skills/`, `.pi/agents/`, `.pi/workflows/`, returning a unified node list distinguished by `source`.
  - New edges: `agent → skill` (kind: `composes`), `workflow step → skill/workflow` (kind: `step`). Existing `uses` and `link` edges remain for the skill domain.
  - `GET /api/kb/graph` response shape is backward compatible — the existing `nodes/edges/diagnostics` keys are preserved; the only change is the set of `source` values now includes `'agent'` and `'workflow'`.
  - The kb-event-bus already fires `kb.changed` for any path under `.pi/`; the watcher's root is widened from `.pi/skills/` to `.pi/`.
- Extended `probe` (real pi probe)
  - The probe handler now spawns `pi --version` with a 3-second `AbortSignal.timeout()`, parses `^\d+\.\d+\.\d+$` from stdout, and reports `{ok, version, latencyMs, error?}`. Replaces the existing auth.json heuristic.
  - Tests inject a fake `spawnPi` for determinism; a separate env-gated live smoke runs the real spawn when pi is available.

## Scope

**In scope**
- All five spec changes above.
- Atomic-write helper (`writeKbFile`) generalized from Stage 6's skill-writer; agents and workflows use it.
- Updated kb-watcher root from `<workspace>/.pi/skills/` to `<workspace>/.pi/`. `skillsDir` field on `Wiring` is renamed to `kbRoot` with a back-compat alias to `skillsDir` pointing at `<kbRoot>/skills` so existing route handlers keep working unchanged.
- A regression smoke that drives a `kb.changed` event for an agent and asserts the graph's `source: "agent"` count grows.
- Real pi probe: deterministic unit tests + one env-gated live smoke (skips when `pi` is not on PATH).

**Out of scope**
- Frontend changes. That's Change 2.
- Agent-callable `create_agent` / `create_workflow` tools (Phase 3 follow-up — same deferral as the agent-callable `create_skill`).
- Workflow execution engine (Phase 2 Stage 12 — workflows here are first-class data, not yet executable).
- Memory format beyond plain markdown.
- The actual content (the WK skill catalog from `~/WK-GHCOS` — that's Stream B once you answer the prereq questions).

## Impact

- Affected specs: `agents` (new), `workflows` (new), `memory` (new), `providers` (new), `kb` (extended), `probe` (modified).
- Affected code: `src/types/kb.ts`, `src/server/kb-browser.ts`, `src/server/kb-watcher.ts`, `src/server/wiring.ts`, `src/routes/kb.ts`, new `src/server/{agent,workflow,memory}-writer.ts`, new `src/routes/{agents,workflows,memory}.ts`, `src/routes/probe.ts`, `src/server.ts` (route table).
- New tests under `tests/{agent,workflow,memory}-{writer,route}.test.mjs`, extension of `tests/kb-browser.test.mjs` for the new node kinds, `tests/probe.test.mjs` (new) with a fake `spawnPi`.
- Risk: medium. `kbRoot` widening could leak diagnostics from non-skill paths into the existing `/api/kb/graph` response. Mitigation: each kind is parsed under its own subdir; unknown subdirs are ignored with a low-severity diagnostic.

## Amendments

**2026-05-06 — chat-controls split out.** The original proposal bundled multi-model chat + tool approval (`extension_ui_request` forwarding, `set_model` RPC, `bridge.cycleModel`) under section 9. That work is real but its consumer is the frontend Settings + composer surfaces, which live in the next change. To keep this change focused on backend data plumbing the frontend rebuild will read from, the `chat-controls` delta spec and section 9 of `tasks.md` have been moved to a follow-up change `add-chat-controls-multi-model`. The seven specs that remain — `kb`, `probe`, `skills`, `agents`, `workflows`, `memory`, `providers` — are all implemented, tested (194 unit tests green, +20 new for the new domains), and ready to archive.
