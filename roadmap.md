# Roadmap

## Phase boundaries

| Phase | Scope | Trigger to start | Effort |
|---|---|---|---|
| **Phase 1 — MVP** | Stages 0-11 (chat, KB, Confluence, skill creation) | Spec locked ✅ | ~22h |
| **Phase 2 — Workflow engine** | Stage 12 (`add-workflow-engine`) | Phase 1 demo lands cleanly + GBS-IPM-DXG buy-in | ~10h |
| **Phase 3 — Adoption follow-ups** | Cobra federation, memory editor, multi-tenant, Electron, etc. | Phase 2 ships + a real user requests it | TBD |

## Phase 1 milestones

| | Milestone | Goal | Estimated effort |
|---|---|---|---|
| **M0** | Spec frozen | Codex round-3 approval (✅ done 2026-05-05) | – |
| **M1** | Backend spine | Stages 0-3 complete; replay + cancellation working via curl | ~8h |
| **M2** | Demo data flow | Stages 4-6 complete; KB graph + Confluence + skill creation working via curl | ~7.5h |
| **M3** | UI shell | Stages 7-9 complete; chat + graph + Confluence panel visible in browser | ~7h |
| **M4** | Demo-ready | Stages 10-11 complete; demo script reproduces 7-step path 3x cleanly | ~3h |

**Phase 1 estimated total: ~22 hours.**

## Phase 2 milestone

| | Milestone | Goal | Estimated effort |
|---|---|---|---|
| **M5** | Workflow engine | Stage 12 complete; user can compose multiple skills into a named, durable, replayable workflow + main agent can spawn sub-agents to author workflows | ~10h |

**Trigger:** Phase 1 demo lands cleanly with the SRE persona + GBS-IPM-DXG either approves or shows interest.

## Stages within milestones

The full Phase 1 stage table lives in `cloudops-workspace-spec.md` §6. Summary:

### Phase 1 (MVP — ~22h)

| Stage | Slug (OpenSpec change) | Domains | Hours |
|---|---|---|---|
| 0 | `add-server-skeleton` | server, health | 0.5 |
| 1 | `add-pi-event-mapper` | events | 1.5 |
| 2 | `add-pi-rpc-bridge` | pi-rpc, runs, events | 5.0 |
| 3 | `add-run-cancellation` | runs | 1.5 |
| 4 | `add-kb-graph-watcher` | kb | 1.5 |
| 5 | `harden-confluence-integration` | confluence | 3.0 |
| 6 | `add-skill-creation-flow` | skills, runs | 3.0 |
| 7 | `add-probe-and-auth` | auth, probe | 1.0 |
| 8 | `add-frontend-shell` | frontend | 3.0 |
| 9 | `add-kb-graph-ui` | frontend, kb | 3.0 |
| 10 | `add-confluence-panel` | frontend, confluence | 1.5 |
| 11 | `polish-demo` | (cross-cutting) | 1.5 |

### Phase 2 (committed follow-up — ~10h)

| Stage | Slug (OpenSpec change) | Domains | Hours |
|---|---|---|---|
| **12** | `add-workflow-engine` | **workflows**, runs, frontend | **~10** |

**Stage 12 scope (committed but not yet specced):**

- A workflow is a named, durable, replayable plan composed of **a sequence (or DAG) of skills + intermediate decisions**. Stored as `.pi/workflows/<name>/WORKFLOW.md` (frontmatter + body, same shape pattern as skills).
- **Main agent can author workflows by spawning sub-agents** (the original Phase 1 intent, now realized at the workflow level instead of the skill level). Reuses Stage 6's subagent pattern + atomic-write helper.
- New API endpoints: `POST /api/workflows` (create), `GET /api/workflows` (list), `POST /api/workflows/:name/run` (execute), `GET /api/workflows/:name` (read).
- New SSE events: `workflow.start`, `workflow.step.start/end`, `workflow.completed/failed`.
- New UI: workflow tab in sidebar, workflow editor (composes existing skills via drag-drop OR markdown), workflow run viewer.
- Architecture seam already in place: Stage 6's atomic-write helper + chokidar watcher trivially extend to a `.pi/workflows/` directory.

**Stage 12 OpenSpec change folder will be created when Phase 2 starts** (per OpenSpec: never propose a change before the team is about to start it).

### Phase 3 (open follow-ups, no commitment yet)

Listed in the cut list below. Each gets its own OpenSpec change when triggered.

## Sequencing rules (the dependency graph)

```
0 ──┬─► 1 ─► 2 ─► 3 ─► 7 ─► 8 ─► 9 ──► 11
    │                              │
    ├─► 4 ──────────────────────────┤
    │                              │
    └─► 5 ─► 6 ──────────────────────┤
                                    │
                                10 ──┘
```

- **Stage 0** unblocks everything (server + healthcheck).
- **Stages 1-3** are the chat spine — sequential.
- **Stage 4** (KB) and **Stage 5** (Confluence) can run in parallel after Stage 0; both feed Stage 6.
- **Stage 7** (auth) layers in after the backend stages are working; UI never sees an unauthed backend.
- **Stages 8-10** layer the UI on top, feeding Stage 11 (polish).

For a single-developer hackathon we walk this graph linearly (0 → 1 → 2 → ... → 11), not in parallel. The graph documents what *could* parallelize if we add bodies.

## Per-stage rule (from the locked spec)

Each stage = development + test + user-reviewed test data + commit. **Never start stage N+1 until stage N is committed.** No partial-state PRs, no skipping verification.

OpenSpec adds: **never write code before there is a proposed change in `openspec/changes/<slug>/`.** Each stage opens a new change folder, builds against its delta specs, archives on completion.

## Cut list (Phase 3 — non-committed follow-ups)

These are valuable but not on the demo path AND not part of the Phase 2 commitment. Each becomes its own OpenSpec change when a real user requests it:

- Memory editor (originally Stage 9 v1) → `add-memory-editor`
- xterm terminal panel for remote VM → `add-remote-terminal-panel`
- Conductor / Swarm / Tasks / Pipelines tabs → `add-conductor`, `add-swarm-mode`
- TanStack Start migration (currently Vite + Lit) → `migrate-to-tanstack-start`
- Monaco editor (skill/workflow detail) → `swap-marked-for-monaco`
- PWA install → `add-pwa-manifest`
- Electron desktop build → `add-electron-build`
- Persistent skill store / git-sync → `add-skill-git-sync`
- Cobra MCP federation (waits for `wk-gbs` GitHub access) → `add-cobra-mcp-federation`
- Self-update → `add-self-update`
- Full unit-test suite → `expand-test-coverage`

**The committed Phase 2 (workflow engine) was previously on this list. It is now promoted to Stage 12 of the roadmap above.**

## Triggers — when each post-MVP stage starts

| Trigger | Next action |
|---|---|
| **Phase 1 demo lands cleanly with the SRE persona** | **Begin Stage 12 (`add-workflow-engine`) — committed Phase 2.** Open the OpenSpec change folder, propose, design, build, archive. |
| GBS-IPM-DXG asks for production graduation | Phase 3 stage: package one mature workflow as a Cobra MCP server (Coupa → Orca → publish). pi-workspace becomes the prototyping fast-lane that feeds Cobra. |
| Memory editor requested by an SRE | Phase 3 stage: `add-memory-editor` |
| Multi-user requested | Major redesign — refresh `mission.md` first, then spec changes |
| Cobra `wk-gbs` access granted | Phase 3 stage: `add-cobra-mcp-federation` |
