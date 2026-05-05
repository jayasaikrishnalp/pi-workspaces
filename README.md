# CloudOps Workspace

> An SRE command center wrapping the `pi` agent CLI for Wolters Kluwer CloudOps. Single browser tab: chat with an AI that knows your runbooks, watch its knowledge grow as it learns from Confluence, save what you learned as permanent skills.

**Status:** spec frozen, awaiting Stage 0 build. No production code yet.

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
