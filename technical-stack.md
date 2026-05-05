# Technical Stack

> What we're building with, and why. Decision-by-decision. Anything not listed here is rejected — see `cloudops-workspace-spec.md` §10 (out of scope).

## Runtime

| Layer | Choice | Pinned version | Why |
|---|---|---|---|
| Backend runtime | Node.js | ≥22.0.0 | LTS, ES2022 native, `fetch` built in, `http` module + `--import` flag |
| TypeScript | `typescript` | ^5.6.0 | Strict mode, NodeNext modules |
| TS execution | `tsx` | ^4.19.0 | No compile step in dev; production can switch to `tsc --build` later |
| Package manager | npm | ships with Node 22 | No pnpm/yarn — single-developer project, no workspace needs |

## Backend

| Concern | Choice | Why we did NOT pick the alternative |
|---|---|---|
| HTTP server | Raw `node:http` | Express/Fastify/Hono add deps and indirection for routing <300 LoC. Re-evaluate at >20 routes. |
| WebSockets | `ws@^8.19.0` | Standard. Used for xterm bridge in Phase 2 (not MVP). |
| Filesystem watching | `chokidar@^4.0.0` | Validated in Spike 3: handles atomic rename, awaitWriteFinish works on Linux + macOS APFS. |
| Schema validation | `@sinclair/typebox@^0.34.0` | Pi extensions already use it; consistency. |
| `.env` parsing | `dotenv@^16.4.0` | Codex flagged homemade parsing in Spike 5 as wrong for quotes/comments/exports. |
| HTML sanitizing | `sanitize-html@^2.13.0` | Codex flagged regex stripping as inadequate for Confluence content. |
| Process management | `node:child_process` with `detached: true` | Required for negative-PID process group kill (cancellation flow). |
| Persistence | Plain JSON files in `~/.pi-workspace/` (atomic: tmp + rename) | No SQLite, no Postgres. Run-store is event log <1MB per run. |
| HTTP framework code budget | <300 LoC for all routing dispatch | Hard cap. If we exceed, that's a signal to revisit framework choice. |

## Frontend

| Concern | Choice | Alternative considered |
|---|---|---|
| Build tool | Vite | TanStack Start (deferred to Phase 2 — too much framework for hackathon) |
| Component model | Lit web components | React (deferred) — Lit is lighter, web-component wrappers convert later |
| Routing | Hash routing (manual) | TanStack Router (deferred) |
| Styling | Tailwind CSS v4 | None other considered — Tailwind matches hermes-workspace reference |
| Terminal | `xterm@5.3.0` + `xterm-addon-fit@0.8.0` + `xterm-addon-web-links@0.9.0` | Same versions as our spike validation |
| Graph layout | D3 force layout (`d3-force`, `d3-selection`, `d3-zoom`) | Cytoscape, vis-network — D3 is enough for ≤500 nodes |
| Markdown rendering | `marked` (lightweight) | `react-markdown` requires React; we're on Lit |
| Code editor | None for MVP — render skill body as static markdown | Monaco (deferred to Phase 2) |
| State | Zustand-style stores in plain TS | TanStack Query (deferred — not enough server data for MVP) |
| HTTP client | native `fetch` + `EventSource` | No axios, no swr — built-ins are fine |

## Pi runtime + extensions

| Concern | Choice |
|---|---|
| Agent runtime | `@mariozechner/pi-coding-agent` (pi v0.73+) installed globally on the VM |
| Auth | GitHub Copilot OAuth (Spike 1.5 verified) — `~/.pi/agent/auth.json` |
| Default model | `github-copilot/claude-sonnet-4.6` with `thinking_level=medium` |
| Subagent pattern | `child_process.spawn('pi', ['--print', '--mode', 'json', ...])` (Spike 4 verified) |
| Tool registration | `pi.registerTool({...})` from extension TS modules in `~/.pi/agent/extensions/` or `<workspace-cwd>/.pi/extensions/` |
| Skill format | Markdown with YAML frontmatter (`name`, `description`, optional `tags`, `uses`, `disable-model-invocation`) |

## External integrations

| System | Auth | Endpoint |
|---|---|---|
| Confluence | Atlassian API token (`ATLASSIAN_API_TOKEN`, fallback `JIRA_TOKEN`) + email (Basic auth) | `https://wkengineering.atlassian.net` (allowlisted at allow-listed regex `^https://wkengineering\.atlassian\.net$`) |
| Azure DevOps | PAT (`AZURE_DEVOPS_EXT_PAT` / `PAT_TOKEN`) | `https://dev.azure.com/wkrainier` |
| Cobra (deferred) | `wk-gbs` GitHub access pending | `workflow.cobra.wkcloud.io` |

Credentials live in `~/.pi/agent/.env` on the VM (mode 0600). Dev token for the workspace itself lives in `~/.pi-workspace/dev-token.txt` (mode 0600).

## Process model

```
~/pi-workspace-server/                    (the Node process)
  └─ spawns pi --mode rpc (detached child, own process group)
      └─ pi tools may spawn pi --print --mode json (subagents in same process group)
```

Cancellation kills the whole process group via `kill(-pgid, SIGTERM)` then `kill(-pgid, SIGKILL)` after 1s.

## Wire format

The locked spec (`cloudops-workspace-spec.md`) §2 defines:

- Identifiers: `sessionKey`, `tabId`, `runId`, `seq` (numeric), `eventId` (`${runId}:${seq}`), `turnId`, `messageId`, `toolCallId`
- 24 normalized SSE event names across 2 channels (`/api/chat-events` + `/api/runs/:runId/events` for replay-aware chat; `/api/kb/events` for FS changes)
- Replay: single-handler `'queueing' → 'streaming'` pattern, dedup by numeric `seq`
- Cancellation: `spawn(detached:true)` + negative-PID kill + idempotent `run.completed`

This is the contract every stage builds against.

## Infrastructure

| Concern | Choice for MVP | Phase 2 |
|---|---|---|
| Where workspace runs | Ubuntu 24.04 VM (the development VM at `kk_user@3.81.200.3`) | Each SRE's laptop |
| Where browser runs | SRE's laptop | Same |
| How browser reaches workspace | Direct `localhost:8766` if same machine; Tailscale tunnel otherwise | Tailscale |
| Process supervisor | `start.sh` (interactive) | systemd unit |
| TLS | None (loopback only) | Tailscale handles encryption |
| Logging | stdout (captured by terminal) | Phase 2: structured logs to `~/.pi-workspace/logs/` |

## Testing

| Type | Tool | When |
|---|---|---|
| Smoke (e2e) | Plain `node --test tests/*.smoke.mjs` | Per-stage, before commit |
| Unit | Same `node:test` for pure modules (e.g., `pi-event-mapper`) | When pure functions exist |
| UI smoke | Manual + screenshots; Playwright deferred to Phase 2 | Stages 8-11 |
| Fixtures | JSONL of recorded pi events + expected SSE events | Stage 1 onwards |

No coverage targets for MVP — hackathon scope.

## What we explicitly chose NOT to use

- **Express / Fastify / Hono** — framework bloat for <300 LoC routing
- **TanStack Start / Next.js** — too much framework for weekend
- **React** — Lit is enough; convert later if needed
- **Monaco editor** — bundle size; static markdown for MVP
- **PostgreSQL / SQLite** — JSON files are sufficient
- **Docker** — single-process VM deploy
- **Kubernetes** — single-process VM deploy
- **OpenAPI** — locked spec is the contract; OpenAPI doc generation deferred
- **gRPC** — JSON-line stdio + SSE is the wire format
- **Authelia / Keycloak** — single-user dev token; real auth in Phase 2
