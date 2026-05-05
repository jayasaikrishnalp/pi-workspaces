# OpenSpec Agent Instructions — CloudOps Workspace

This repository uses [OpenSpec](https://github.com/Fission-AI/OpenSpec) conventions for spec-driven development.

The project is a web workspace wrapping the `pi` agent CLI for Wolters Kluwer CloudOps SREs. The locked design overview lives in `/Users/jayasaikrishnayerramsetty/research-folder/cloudops-workspace-spec.md` (v3, Codex-approved). That document is the **product spec**. OpenSpec captures **per-change behavioral contracts** that flow into a single source of truth as we build.

## Ground rules for AI agents

1. **Do not write code before there is a proposed change for it.** If the user asks for something not covered by an in-flight change in `openspec/changes/<slug>/`, propose one first.
2. **Specs describe observable behavior, not implementation.** Avoid mentioning class/function names, library choices, or code-level details in `openspec/specs/**` or the delta `specs/**` of a change. Those go in `design.md`.
3. **Use RFC 2119 keywords** in requirements: MUST, SHALL, SHOULD, MAY, MUST NOT.
4. **Use Given/When/Then** for scenarios.
5. **Deltas, not restatements.** In a change's `specs/**`, only write `## ADDED Requirements`, `## MODIFIED Requirements`, `## REMOVED Requirements` sections.
6. **Tasks are granular and checkable.** Each task in `tasks.md` is a single commit-sized step. Use hierarchical numbering and checkboxes.
7. **Archive by merging.** When a change is verified, fold its deltas into `openspec/specs/**` and move the folder to `openspec/changes/archive/YYYY-MM-DD-<slug>/`.
8. **Never edit archived changes.** They are history.
9. **Tests trace to scenarios.** Every `Scenario:` block in a delta spec MUST have at least one corresponding test. Verification is incomplete until that mapping is explicit in `tasks.md`.

## Where to put new information

| Kind of info | Goes in |
|---|---|
| Product spec / locked v3 design | `~/research-folder/cloudops-workspace-spec.md` (out-of-tree) |
| "The system behaves like X today" | `openspec/specs/<domain>/spec.md` |
| "We are changing the system to Y" | `openspec/changes/<slug>/specs/<domain>/spec.md` (delta) |
| "Here's how we'll build it" | `openspec/changes/<slug>/design.md` |
| "Here's the to-do list" | `openspec/changes/<slug>/tasks.md` |

## Stage → Change mapping (planned)

### Phase 1 (MVP)

| Locked-spec Stage | OpenSpec change slug | Domains touched |
|---|---|---|
| 0 | `add-server-skeleton` | `server`, `health` |
| 1 | `add-pi-event-mapper` | `events` |
| 2 | `add-pi-rpc-bridge` | `pi-rpc`, `runs`, `events` |
| 3 | `add-run-cancellation` | `runs` |
| 4 | `add-kb-graph-watcher` | `kb` |
| 5 | `harden-confluence-integration` | `confluence` |
| 6 | `add-skill-creation-flow` | `skills`, `runs` |
| 7 | `add-probe-and-auth` | `auth`, `probe` |
| 8 | `add-frontend-shell` | `frontend` |
| 9 | `add-kb-graph-ui` | `frontend`, `kb` |
| 10 | `add-confluence-panel` | `frontend`, `confluence` |
| 11 | `polish-demo` | (cross-cutting) |

### Phase 2 (committed — starts after Phase 1 demo lands)

| Stage | OpenSpec change slug | Domains touched |
|---|---|---|
| 12 | `add-workflow-engine` | `workflows`, `runs`, `frontend` |

Each row becomes a folder under `openspec/changes/` when its stage starts. Phase-3 follow-ups (cut list in `roadmap.md`) will get their own slugs when triggered by a real user request.
