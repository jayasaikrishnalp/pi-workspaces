# Tasks: MCP Broker — Backend Pool + Pi Bridge Extension

## 1. Dependency + config foundation

- [x] 1.1 `npm install @modelcontextprotocol/sdk@^1` and pin in `package.json`. Verify via `npm ls`.
- [x] 1.2 `src/server/mcp-config.ts` — exports `McpServerConfig` type union, `loadSeedConfig(env)` returning the static catalog. Ref-key resolver: `process.env.REF_API_KEY` first; fallback to in-memory lift from `~/.claude.json` at `mcpServers.Ref.headers["x-ref-api-key"]`. Lift is best-effort and never persists.
- [x] 1.3 `src/types/mcp.ts` — `McpConnectionStatus`, `McpServerStatus`, `Tool`, `QualifiedTool`. Lives next to `src/types/kb.ts`.

## 2. McpClient (transport-specific)

- [x] 2.1 `src/server/mcp-client-stdio.ts` — wraps SDK's stdio transport. Methods: `start()`, `listTools()`, `callTool(name, args, signal)`, `shutdown()`. SIGTERM with 1s grace then SIGKILL.
- [x] 2.2 `src/server/mcp-client-http.ts` — wraps SDK's HTTP transport. Same surface as stdio variant. Forwards configured headers (e.g., `x-ref-api-key`).
- [x] 2.3 Both honor `AbortSignal` on `callTool` and surface a clean error on transport failure.

## 3. McpBroker

- [x] 3.1 `src/server/mcp-broker.ts` — owns `Map<id, McpClient>`. Methods: `getStatus()`, `getTools()` (flattens), `callTool(serverId, toolName, args)`, `shutdownAll()`.
- [x] 3.2 Lazy-connect: a server is only `start()`-ed on first `getTools(serverId)` or `callTool(serverId, ...)` call. Status transitions: `disconnected → connecting → connected | error`.
- [x] 3.3 Wire to `Wiring`: `mcpBroker: McpBroker`. `startServer()` constructs it. `server.close` triggers `mcpBroker.shutdownAll()`.

## 4. Routes

- [x] 4.1 `src/routes/mcp.ts` — `handleMcpServersList`, `handleMcpToolsList`, `handleMcpCall`. Standard error mapping per spec (UNKNOWN_SERVER 400, UNKNOWN_TOOL 400, INVALID_ARGS 400, MCP_TRANSPORT_ERROR 502, MCP_TIMEOUT 504).
- [x] 4.2 Register in `src/server.ts` route table behind cookie auth.
- [x] 4.3 `src/routes/probe.ts` — append `mcp: {servers: McpServerStatus[]}` to the response body.

## 5. Pi bridge extension

- [x] 5.1 `extensions/mcp-bridge/index.ts` — reads `~/.pi-workspace/server.port`, fetches `/api/mcp/tools`, calls `pi.registerTool` per tool with name `mcp__<serverId>__<toolName>`. Handler does `POST /api/mcp/call`.
- [x] 5.2 No-op gracefully when the port file is missing or the backend is unreachable. Log a single-line warning; never throw.
- [x] 5.3 `start.sh` — copy `extensions/mcp-bridge/` to `~/.pi/agent/extensions/`. Idempotent (skip if up to date).
- [x] 5.4 `start.sh` — no key prompt. The backend lifts `REF_API_KEY` in-process from `~/.claude.json` per the resolver order. Operators who want to override do so via `export REF_API_KEY=...` before launching.
- [x] 5.5 `startServer()` writes `~/.pi-workspace/server.port` on listen and removes it on close.

## 6. Tests

- [x] 6.1 `tests/mcp-broker.test.mjs` — stub `McpClient`s and exercise lifecycle: cold list reports disconnected; first `callTool` triggers connect; `shutdownAll` SIGTERMs then SIGKILLs.
- [x] 6.2 `tests/mcp-route.test.mjs` — stub broker, full HTTP surface: list servers, list tools, call success, UNKNOWN_SERVER 400, UNKNOWN_TOOL 400, MCP_TIMEOUT 504 (using a fake-clock-or-short-timeout pattern).
- [x] 6.3 `tests/probe.test.mjs` — extend (or add) coverage that probe surfaces `mcp.servers` with the expected shape.
- [x] 6.4 `tests/integration/mcp-live.smoke.mjs` — hits the real Ref MCP server and asserts a non-empty result for `ref_search_documentation`. NOT included in the default `npm test` glob. Add `npm run smoke:mcp` script in `package.json` that runs only this file. Script aborts cleanly if `REF_API_KEY` is unset (and lift returns nothing).

## 7. Hand-test the end-to-end pipe

- [x] 7.1 Boot the workspace with a real `REF_API_KEY`, hit `GET /api/mcp/tools`, see Ref + Context7 tools listed.
- [ ] 7.2 Boot pi with the bridge extension installed, send a chat that should trigger `mcp__ref__ref_search_documentation`, observe the tool fires and returns documentation hits.
- [ ] 7.3 Kill the workspace mid-chat, verify pi stays up and only the MCP tools become unavailable (graceful degradation).

## 8. Review + verification

- [x] 8.1 Every requirement scenario in `specs/mcp/spec.md` backed by at least one test.
- [x] 8.2 Full local suite green.
- [x] 8.3 Codex review iterated to clean.
- [x] 8.4 Three commits + push (propose / implement / archive).
