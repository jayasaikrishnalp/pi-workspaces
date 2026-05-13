# Workflow Conductor — Spec & Design

**Status:** draft for sign-off · **Owner:** jaya · **Date:** 2026-05-07

## 0. Why this is the hero

Hive Workspace today lists workflows as a flat row of cards. The Claude-Design "Conductor" prototype showed a much stronger metaphor: a **Railway-style canvas** where one node is the centered hero, its upstream and downstream peers float above/below with dotted "rain" connectors, and a side rail shows the hero's full detail (response, skills, links). The user's existing data model — workflows as ordered `steps[]` of `skill:<name>` or `workflow:<name>` — fits this metaphor cleanly: the "hero" is the **selected step**, upstream is the **previous step**, downstream is the **next step(s)**.

We are *not* building the agent-network Conductor (router/reviewer/operator/specialist/writer). We are taking its visual language and applying it to **Workflow execution and editing**. Workflows are the productized unit of work; this screen is where operators see a workflow, run it, and watch it progress.

## 1. Goals

1. **A workflow becomes navigable, not a list row.** Operator sees the whole step chain at a glance, can click any step to focus it, and sees rich detail in a side rail.
2. **Workflows become runnable from the UI.** A "Run now" button kicks off an execution; the canvas animates step status (ready → running → completed/failed) live.
3. **Editing in place.** Add/remove/reorder steps from the side rail, attach/detach the underlying skills, with the canvas updating immediately.
4. **Looks like the design.** KodeKloud LaunchPad tokens (deep obsidian surfaces, cyan accent, mono-heavy type, dotted grid background, glow on active state).

Out of scope (this iteration): branching steps, parallel fan-out, conditional routing, agent-as-step, run replay browser, multi-tenant teams.

## 2. Visual layout

Two-column shell — same shape as Conductor, retitled for our domain:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ PageHeader   icon  "Workflows"   subtitle    [Runs] [Sync] [+ Workflow] │
├──────────────────────────────────────────────────────────────────────────┤
│                                                       │                  │
│  ┌─ canvas (grid bg, vignette) ─────────────────┐    │  Side Rail       │
│  │                                              │    │                  │
│  │   [previous step mini-card]                  │    │  Avatar · Name   │
│  │              │  (dotted connector + pulse)   │    │  Step kind       │
│  │   ┌──────────────────────────────────┐       │    │  Status pill     │
│  │   │  HERO STEP CARD                  │       │    │                  │
│  │   │  avatar + name + status pill     │       │    │  Meta grid       │
│  │   │  role / skill description        │       │    │  (kind, ref,     │
│  │   │  "running · last run 2m ago"     │       │    │   p50, success,  │
│  │   │  ── snippet of last output ──    │       │    │   last 5 runs)   │
│  │   │  foot: skills • model • profile  │       │    │                  │
│  │   └──────────────────────────────────┘       │    │  Tabs:           │
│  │              │                               │    │  · Output        │
│  │   [next step mini-card] [next mini-card]     │    │  · Skill detail  │
│  │                                              │    │  · Run history   │
│  │  ┌ canvas chrome (top-right) ─┐              │    │                  │
│  │  │ [Sync] [+ Step]            │              │    │  Foot:           │
│  │  └─────────────────────────────┘              │    │  [Pause] [Spec] │
│  │                                              │    │       [Run now] │
│  │  ┌ zoom rail (right edge) ┐                  │    │                  │
│  │  │ ☰  +  −  ⤢            │                  │    │                  │
│  │  └────────────────────────┘                  │    │                  │
│  │                                              │    │                  │
│  │  ┌ bottom toolbar ─────────────────────────┐│    │                  │
│  │  │ [Run] [Steps] [Skills] [Runs] [Spec]    ││    │                  │
│  │  │                            [▲ Activity] ││    │                  │
│  │  └──────────────────────────────────────────┘│    │                  │
│  └──────────────────────────────────────────────┘    │                  │
│                                          1fr         │       380px      │
└──────────────────────────────────────────────────────────────────────────┘
```

Mobile (< 1080px) stacks: canvas top, rail bottom (max-height 50vh), per the design's existing media query.

## 3. Component map (React)

All under `web/src/components/screens/conductor/` (new folder). Lifted from the prototype `src/conductor.jsx` and TypeScript-ified:

| Component               | Source ref               | Notes                                                                                                                                            |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkflowConductor`     | `ConductorScreen`        | Top-level. Holds `heroStepIndex`, fetches workflow, owns the run-control. Replaces the current `WorkflowsScreen` for the detail view.            |
| `WorkflowList`          | (new)                    | Existing list view becomes the *picker* — a top-bar dropdown / left strip listing workflows. Click to set the active workflow; render conductor. |
| `WFHeroCard`            | `CDHeroCard`             | The big centered card. Title = step ref. Status, response/output snippet, foot stats.                                                            |
| `WFMiniNode`            | `CDMiniNode`             | Upstream/downstream peer mini-cards.                                                                                                             |
| `WFConnectors`          | `CDConnectors`           | Dotted vertical lines + animated pulse. Pulse animates only when step is `running`.                                                              |
| `WFCanvasChrome`        | `cd-canvas-chrome`       | Top-right Sync + "+ Step" buttons.                                                                                                               |
| `WFZoomRail`            | `cd-zoom-rail`           | Decorative pan/zoom controls. Functional zoom is nice-to-have; v1 is decorative.                                                                 |
| `WFBottomToolbar`       | `cd-toolbar`             | Run / Steps / Skills / Runs / Spec tabs at bottom of canvas — switches what the side rail shows.                                                 |
| `WFActivityChip`        | `cd-activity`            | Bottom-right pulse + "Activity" expander — opens a slide-up panel of recent run events for *this* workflow.                                      |
| `WorkflowRail`          | `ConductorRail`          | Right side rail. Tabs: Output / Skill / Runs. Foot actions Pause / Spec / Run now.                                                               |

A workflow with `[skill:check, skill:reboot, skill:verify]` and the user clicking step 2 (`reboot`) renders:

- Hero: `reboot` (running pulse if active).
- Upstream: one mini-card `check`.
- Downstream: one mini-card `verify`.
- Rail Output tab: stdout/stderr from the most recent invocation of `reboot` in the last run.

## 4. Data model

### 4.1 Workflow shape (existing — no change)

`<kbRoot>/workflows/<name>/WORKFLOW.md` with frontmatter:
```yaml
name: kafka-rotate
description: Rotate kafka SSL certs
steps:
  - skill:check-kafka-health
  - skill:rotate-cert
  - skill:verify-handshake
  - workflow:notify-slack
```

### 4.2 NEW: workflow run (added)

A workflow run is a recorded execution. Stored in SQLite via a new `WorkflowRunsStore` (no migration needed — reuse `runs` table conventions):

```sql
-- Migration 005_workflow_runs.sql
CREATE TABLE IF NOT EXISTS workflow_runs (
  id          TEXT PRIMARY KEY,            -- uuid
  workflow    TEXT NOT NULL,                -- workflow name
  status      TEXT NOT NULL,                -- queued | running | completed | failed | cancelled
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  triggered_by TEXT,                        -- 'operator' | 'agent' | 'cron'
  step_count  INTEGER NOT NULL DEFAULT 0,
  step_done   INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS workflow_step_runs (
  run_id      TEXT NOT NULL,
  step_index  INTEGER NOT NULL,
  step_kind   TEXT NOT NULL,                -- 'skill' | 'workflow'
  step_ref    TEXT NOT NULL,
  status      TEXT NOT NULL,                -- queued | running | completed | failed | skipped
  started_at  INTEGER,
  ended_at    INTEGER,
  output      TEXT,                         -- captured stdout/result snippet, capped 4KB
  error       TEXT,
  PRIMARY KEY (run_id, step_index),
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_wf_step_runs_run ON workflow_step_runs(run_id);
```

### 4.3 NEW: API surface

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/workflows/:name/runs` | last N runs (default 20) |
| `GET`  | `/api/workflows/:name/runs/:runId` | single run with all step rows |
| `POST` | `/api/workflows/:name/run` | start a new run; returns `{ runId }`. Body optional `{ inputs?: Record<string,string> }` |
| `POST` | `/api/workflows/:name/run/:runId/cancel` | mark run cancelled, signal in-flight step |
| `GET`  | `/api/workflows/:name/run/:runId/events` | SSE stream of `{kind: 'step.start'|'step.output'|'step.end'|'run.end', stepIndex, ...}` |

**Execution semantics for v1 (deliberately tiny):**
- Sequential. Step *i+1* starts only after step *i* completes successfully. Failure halts the run.
- A `skill:<name>` step invokes the skill via existing pi bridge with the workflow's accumulated context as the prompt; output is the agent's text response. (No skill-defined input schema yet — that's a later spec.)
- A `workflow:<name>` step recursively invokes the sub-workflow and treats its final step's output as its own.
- One run at a time per workflow (409 if already in flight, mirroring `send-stream`'s ACTIVE_RUN pattern).

## 5. Design tokens

Adopt KodeKloud LaunchPad tokens *additively* — the existing `web/src/index.css` keeps working; the new conductor screen uses the new variables. Tokens copied from `assets/tokens.css`:

- Surfaces: `--bg-primary #1e1e22`, `--bg-secondary #26262c`, `--bg-card #2a2a32`, `--bg-glass`.
- Borders: `--border #3d3d3d`, `--border-active #1dacfe`.
- Accent: `--accent #1dacfe` (KodeKloud cyan), `--accent-hover #40bcff`.
- Semantic: `--green #22c55e`, `--yellow #eab308`, `--red #ef4444`, `--orange #f97316`.
- Type: Inter (already loaded), JetBrains Mono (load via Google Fonts in `index.html` head).
- Step kinds → colors (mapping from `KIND_META`):
  - `skill` (default): cyan `#1dacfe` (was "reviewer").
  - `workflow` (sub-workflow step): purple `#a78bfa`.
  - terminal step ("execute" steps that shell out): green `#8aff88` (reserved, not in v1).

Files to create:
- `web/src/components/screens/conductor/conductor.css` — port the `.conductor-stage`, `.cd-canvas`, `.cd-hero`, `.cd-mini`, `.cd-connectors`, `.cd-rail` rules from the prototype's `sidebar.css` (lines 980–1268). Rename `cd-` → `wfc-` to avoid collision with any future agent-conductor work.
- Append to `web/src/index.css` (or a new `tokens.css` imported once): the `:root` token block from `assets/tokens.css`.

## 6. Animations

Lifted from the prototype, kept restrained:
- Step status `running` → pulsing dot (`pulse-glow 1.6s infinite`).
- Hero card mount → `slide-in-right .25s ease both` for the rail.
- Connector line → static dotted; the **pulse blob** along it animates only when the *next* step is currently running, signaling "data is flowing now."
- Canvas background → static dot grid + radial cyan glow at center; no continuous motion (avoids 2 a.m. fatigue per the chat transcript).

No particle effects, no scanlines (those were "vibe variants" the user opted out of for production).

## 7. Phased implementation

Each phase is independently shippable.

### Phase A — Read-only Conductor view (no run yet)
1. Create `conductor/` folder + components, port CSS.
2. New screen route `'workflow'` (or repurpose `'workflows'`) renders `WorkflowConductor` for the picked workflow.
3. Workflow picker = small select in the page header (or a left strip).
4. Hero/mini-node/rail render statically from the workflow's `steps[]`.
5. Side rail tabs: Steps (full step list), Skills (resolved skill descriptions from `kb-browser.ts`), Spec (the raw `WORKFLOW.md`).
6. **Looks like the design.** Visual sign-off here.

### Phase B — Run execution (new backend)
7. Migration 005 + `WorkflowRunsStore` + new routes.
8. Sequential executor in `src/server/workflow-runner.ts` that walks `steps[]`, invokes each via `pi-rpc-bridge.send()`, captures output, persists step rows, emits SSE events to a per-run `WorkflowRunBus`.
9. Wire `Run now` button → `POST /api/workflows/:name/run` → subscribe to `/run/:id/events` → animate hero/mini status pills as events arrive.
10. Side rail Output tab subscribes to live step output for the focused step.

### Phase C — Edit in place (in-canvas mutation)
11. `+ Step` button in canvas chrome opens a small popover: pick skill or workflow, insert at position. PUTs back to `/api/workflows/:name`.
12. Drag-to-reorder mini cards (HTML5 DnD; v1 is up/down arrows on hover).
13. Detach/attach skill from the rail's Skill tab.

Phases B and C can be parallel after Phase A. Default landing: ship A first, demo, then B.

## 8. Files

### To create
- `specs/workflow-conductor.md` (this file)
- `src/server/db-migrations/005_workflow_runs.sql`
- `src/server/workflow-runs-store.ts`
- `src/server/workflow-runner.ts`
- `src/server/workflow-run-bus.ts` (SSE bus, mirroring `kb-event-bus.ts`)
- `src/routes/workflow-runs.ts`
- `web/src/components/screens/conductor/WorkflowConductor.tsx`
- `web/src/components/screens/conductor/WFHeroCard.tsx`
- `web/src/components/screens/conductor/WFMiniNode.tsx`
- `web/src/components/screens/conductor/WFConnectors.tsx`
- `web/src/components/screens/conductor/WFCanvasChrome.tsx`
- `web/src/components/screens/conductor/WFBottomToolbar.tsx`
- `web/src/components/screens/conductor/WorkflowRail.tsx`
- `web/src/components/screens/conductor/conductor.css`
- `web/src/components/screens/conductor/tokens.css` (KodeKloud token import)
- `web/src/hooks/useWorkflowRun.ts`

### To modify
- `web/src/components/Sidebar.tsx` — Workflows item already exists; no rename needed.
- `web/src/components/screens/WorkflowsScreen.tsx` — replace body with `WorkflowConductor`; keep the create modal.
- `src/routes/workflows.ts` — add the run / runs / cancel / events handlers.
- `src/server.ts` — register new routes.
- `src/server/wiring.ts` — instantiate `WorkflowRunsStore`, `WorkflowRunner`, `WorkflowRunBus`.
- `web/src/lib/api.ts` — typed clients for the new endpoints.
- `web/src/index.html` head — load JetBrains Mono.

## 9. Verification

### Phase A
- Pick a workflow with 3+ steps in the picker → hero is step 1, downstream shows step 2.
- Click step 2 → it becomes hero, step 1 appears upstream, step 3 downstream.
- Side rail shows the resolved skill description (from `kb-browser.ts`) for the focused step.
- Visual: matches the prototype's `cd-hero` / `cd-mini` / `cd-rail` look at parity (compare tokens, type, glow).

### Phase B
- Click "Run now" → hero status flips to `running`, dot pulses; downstream sequentially activate.
- Failure on a step → that step's status flips to `failed`, run halts, error string surfaces in the rail's Output tab.
- `GET /api/workflows/:name/runs` returns the new row with correct `step_done`.
- SSE stream survives a 30s wait without a heartbeat-induced disconnect.

### Phase C
- Add a step from the canvas → workflow YAML on disk has the new line.
- Reorder → YAML order matches new visual order.

## 10. Open questions

None blocking — everything in the spec is decidable from the existing data model + the design package. If during execution we hit a Phase B ambiguity (e.g. how to pass output between steps), we add it as a sub-spec then.
