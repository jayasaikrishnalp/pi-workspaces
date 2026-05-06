# Proposal: MCP Broker — Backend-Owned MCP Client Pool with a Pi Bridge Extension

## Why

Pi has no built-in MCP support — it's a deliberate design choice (`packages/coding-agent/README.md`: "Build CLI tools with READMEs, or build an extension that adds MCP support"). So if we want SREs to call Ref / Context7 / Confluence-MCP / Atlassian-MCP from inside a pi chat, the workspace has to provide MCP itself.

The architectural choice is between two extremes: pure pi-extension (config invisible to our backend) or pure backend-mediated (operator-driven, agent can't autonomously decide to look something up). Both lose half the value. We're going with the hybrid: **MCP client pool lives in our backend**, **a thin pi extension proxies tool calls back to the backend**. That gives:

- Central config, audit log, kill switches, and Settings UI in our backend (matches the shape of agents/workflows/skills/providers we just shipped).
- Tools register natively in pi's tool-use loop, so the agent can decide on its own to call `ref_search_documentation` mid-reasoning.
- Per-skill / per-agent server allowlists become trivial later — they're just entries in our config.

The user already verified live that Ref (HTTP, `https://api.ref.tools/mcp`) and Context7 (stdio, `npx @upstash/context7-mcp@latest`) work end-to-end with the configs already in `~/.claude.json`. Those two seed the catalog.

## What changes

- New backend domain: **mcp**. A long-lived `McpBroker` owns N `McpClient` connections (one per configured server). Lifecycle: connect on first use, retry with backoff on disconnect, hard-kill on workspace shutdown.
- Static seed config for v1: Ref (HTTP) + Context7 (stdio). Mirrors the `~/.claude.json` shape (`{kind: "stdio"|"http", command/args/env or url/headers}`). The Ref API key is auto-lifted from `~/.claude.json` at startup — operator never re-enters it.
- HTTP routes:
  - `GET /api/mcp/servers` — list configured servers + connection status + tool count.
  - `GET /api/mcp/tools` — flat list of all tools across all connected servers, with `serverId.toolName` namespace.
  - `POST /api/mcp/call` — `{serverId, toolName, args}` → tool result. Used by the pi-bridge extension (and later by the frontend for direct lookups).
- New pi extension at `extensions/mcp-bridge/index.ts` (in this repo, copied to `~/.pi/agent/extensions/` by `start.sh`):
  - On `pi.on("startup")`: `GET /api/mcp/tools`, then `pi.registerTool(...)` once per MCP tool. Each registered tool's handler does `POST /api/mcp/call`.
  - On `pi.on("resources_discover")`: re-fetch the tool list so live config changes propagate.

## Scope

**In scope**
- Backend `McpBroker`, `McpClient`, config loader, three routes, full unit tests with stubbed transports.
- Static seed catalog of 2 servers (Ref + Context7).
- One pi-bridge extension, copied to `~/.pi/agent/extensions/` by `start.sh`.
- An end-to-end smoke test (env-gated; spawns a real pi if available) that proves a chat can call `ref_search_documentation` and get a response.

**Out of scope**
- Multi-server config UI (add/remove/enable/disable in a Settings tab) — lives in the frontend rebuild change.
- Per-skill / per-agent allowlists — Phase 3 follow-up.
- Audit log persistence (each call writes a line to a JSONL file) — nice-to-have, defer.
- Authentication on MCP tool calls beyond what the underlying server requires (Ref's `x-ref-api-key` is forwarded; we don't add another layer).
- Server kill switches with operator confirmation prompts — defer to the frontend approval-gate work in `add-chat-controls-multi-model`.

## Impact

- Affected specs: `mcp` (new), `probe` (modified — surface MCP server count + connection status).
- Affected code: new `src/server/mcp-broker.ts`, `src/server/mcp-client-stdio.ts`, `src/server/mcp-client-http.ts`, `src/server/mcp-config.ts`, new `src/routes/mcp.ts`, `src/server.ts` route table, `src/routes/probe.ts` for the new probe fields.
- New extension at `extensions/mcp-bridge/` (under `cloudops-workspace`, copied by `start.sh` to `~/.pi/agent/extensions/`).
- New tests: `tests/mcp-broker.test.mjs`, `tests/mcp-route.test.mjs`, `tests/integration/mcp-live.smoke.mjs`.
- Risk: medium. MCP client lifecycle has classic gotchas (zombie processes, stuck stdio, slow handshakes). Mitigation: `AbortSignal.timeout` on every call, hard-kill on shutdown, broker-level circuit breaker so one bad server can't stall the others.
