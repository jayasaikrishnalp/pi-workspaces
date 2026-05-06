# Design: MCP Broker

## Approach

The MCP client is a long-lived workspace-scoped pool, not a request-scoped object. Spinning up a stdio MCP server per HTTP request would be slow (npm download + handshake = seconds) and would multiply zombie risk. So `McpBroker` lives on `Wiring` next to the chat bus and run-store, gets started on workspace boot, and is shut down once on workspace exit.

The broker owns the **connection lifecycle and tool catalog cache**. Routes are thin wrappers over broker methods. The pi-bridge extension is a thin wrapper over the routes. Every layer can be tested in isolation:

- `McpClient` — one transport, one MCP server, no broker concerns. Stub `spawn` (stdio) or `fetch` (http).
- `McpBroker` — `Map<serverId, McpClient>` plus config; tested with stub clients.
- Routes — tested with a stub broker.
- Extension — tested by hand against a running backend.

## Architecture

```
┌───────────────────────────────────────┐
│ pi (running locally, on macOS)        │
│  ┌─────────────────────────────────┐  │
│  │ ext: mcp-bridge                 │  │
│  │  pi.on("startup") →             │  │
│  │    GET /api/mcp/tools           │  │
│  │  pi.registerTool(name, handler) │  │
│  │  handler(args) →                │  │
│  │    POST /api/mcp/call           │  │
│  └────────────────┬────────────────┘  │
└───────────────────┼───────────────────┘
                    │ HTTP localhost
┌───────────────────▼───────────────────┐
│ cloudops-workspace backend            │
│  ┌─────────────────────────────────┐  │
│  │ src/routes/mcp.ts               │  │
│  │  GET /servers, /tools           │  │
│  │  POST /call                     │  │
│  └────────────────┬────────────────┘  │
│  ┌────────────────▼────────────────┐  │
│  │ src/server/mcp-broker.ts        │  │
│  │  Map<serverId, McpClient>       │  │
│  │  startAll() / shutdownAll()     │  │
│  │  callTool(srv, tool, args)      │  │
│  └─┬──────────────────────────┬────┘  │
│    │                          │       │
│  ┌─▼──────────┐         ┌─────▼────┐  │
│  │ stdio      │         │ http     │  │
│  │ McpClient  │         │ McpClient│  │
│  └────┬───────┘         └────┬─────┘  │
└───────┼──────────────────────┼────────┘
        │                      │
        ▼                      ▼
   spawn npx @upstash/  https://api.ref.tools/mcp
   context7-mcp@latest        (HTTP+SSE)
```

## Data model

### McpServerConfig

```ts
type McpServerConfig =
  | { id: string; kind: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { id: string; kind: "http";  url: string;     headers?: Record<string, string> }
```

### McpServerStatus

```ts
type McpConnectionStatus = "disconnected" | "connecting" | "connected" | "error"

type McpServerStatus = {
  id: string
  kind: "stdio" | "http"
  status: McpConnectionStatus
  toolCount: number              // 0 unless status === "connected"
  error?: string                 // present when status === "error"
  startedAt?: number             // epoch ms; present when status === "connected"
}
```

### Tool

Mirrors MCP protocol: `{ name, description, inputSchema (JSONSchema) }`. The route flattens to `{ serverId, toolName, qualifiedName: "<serverId>:<toolName>", description, inputSchema }`.

### Seed config (v1, hardcoded in `mcp-config.ts`)

```ts
const SEED: McpServerConfig[] = [
  {
    id: "ref",
    kind: "http",
    url: "https://api.ref.tools/mcp",
    // x-ref-api-key forwarded from process.env.REF_API_KEY (operator-supplied).
    // No key in source — start.sh prompts on first run, persists to ~/.pi-workspace/.env.
  },
  {
    id: "context7",
    kind: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp@latest"],
    env: {},
  },
]
```

## Decisions

- **Decision:** Use `@modelcontextprotocol/sdk` (the official TypeScript SDK) rather than rolling our own JSON-RPC client.
  **Alternatives:** Hand-rolled JSON-RPC over stdio + sseGz over fetch.
  **Why:** SDK handles handshake, reconnect semantics, cancellation, and the surface that's most likely to drift between MCP versions. Saves ~200 lines and avoids a class of bugs.

- **Decision:** Broker is constructed lazily on first request, not eagerly at workspace boot.
  **Alternatives:** Connect all servers on `startServer()`.
  **Why:** Stdio servers take seconds to download & handshake on cold starts; eager-connect makes `npm run dev` painfully slow and breaks tests that don't need MCP. Lazy connect with a "warming" indicator in the probe means the workspace boots fast and the operator sees connection progress in the Settings UI.

- **Decision:** All MCP calls have a 30s timeout via `AbortSignal.timeout(30_000)`.
  **Alternatives:** No timeout (block forever); short 5s timeout.
  **Why:** Some legitimate MCP calls (e.g., context7 fetching a large doc) take 10–20s. 30s is comfortably above the 99th-percentile but bounded enough that a stuck server doesn't permanently lock up the chat.

- **Decision:** Pi extension talks to the backend over loopback HTTP (`http://127.0.0.1:<port>`), not via stdin or a shared file. The extension reads the port from `~/.pi-workspace/server.port` written by `startServer()`.
  **Alternatives:** Pi extension imports the broker module directly (would require running pi inside the backend's Node process).
  **Why:** Keeps pi's process separate from ours; restarting one doesn't kill the other. Localhost HTTP is fast enough (~5ms RTT).

- **Decision:** Tool name collision policy: prefix tools with `<serverId>__` when registering with pi (so `ref_search_documentation` becomes `ref__ref_search_documentation`).
  **Alternatives:** Last-wins; refuse-to-register on collision.
  **Why:** Prefix is unambiguous, deterministic, and lets the operator inspect at a glance which server provided which tool. Matches Claude Code's `mcp__<server>__<tool>` convention.

- **Decision:** REF_API_KEY is auto-lifted from `~/.claude.json` at startup if not already in `process.env`. The key is read at `mcpServers.Ref.headers["x-ref-api-key"]`. The lift happens in-memory only — we do NOT copy the value to our own dotfile or commit it.
  **Alternatives:** Prompt-and-persist on first run.
  **Why:** Operator already configured the key in `~/.claude.json` for Claude Code; making them re-enter it is busy-work. Read-on-startup, never persist; if the key rotates in `~/.claude.json` the workspace picks it up on next boot. Lift is best-effort: if the file or path is missing, the Ref server simply reports `status:"error"` until the operator sets `REF_API_KEY` directly.

## Affected files & packages

- `package.json` — add `@modelcontextprotocol/sdk@latest`.
- `src/server/mcp-config.ts` (NEW) — seed catalog + env loader.
- `src/server/mcp-client-stdio.ts` (NEW) — wraps SDK's stdio client; `start()`, `listTools()`, `callTool()`, `shutdown()`.
- `src/server/mcp-client-http.ts` (NEW) — wraps SDK's HTTP client.
- `src/server/mcp-broker.ts` (NEW) — `Map<id, McpClient>`, `getStatus()`, `getTools()`, `callTool()`.
- `src/server/wiring.ts` — `mcpBroker: McpBroker` field; `startServer` constructs lazily.
- `src/routes/mcp.ts` (NEW) — three handlers.
- `src/server.ts` — register routes; ensure `mcpBroker.shutdownAll()` runs on `server.close`.
- `src/routes/probe.ts` — append `mcp: { servers: McpServerStatus[] }` to the response.
- `extensions/mcp-bridge/index.ts` (NEW, in this repo) — pi extension; copied to `~/.pi/agent/extensions/` by `start.sh`.
- `start.sh` — copy step + REF_API_KEY prompt + `.env` write.
- `tests/mcp-broker.test.mjs`, `tests/mcp-route.test.mjs`, `tests/integration/mcp-live.smoke.mjs` (NEW).

## Risks & mitigations

- **Stuck stdio child blocks shutdown.** → SIGTERM with a 1s grace period, then SIGKILL. `child.unref()` so the broker doesn't prevent process exit on its own.
- **HTTP MCP server returns SSE that never ends.** → `AbortSignal.timeout(30_000)` on every fetch. Cancelling closes the SSE stream cleanly.
- **REF_API_KEY missing AND `~/.claude.json` lift fails.** → Probe surfaces `mcp.servers[0].status === "error"` with a clear "REF_API_KEY not set; ~/.claude.json lift returned no value" message. Other servers continue working.
- **`~/.claude.json` malformed or unreadable.** → Lift returns `null`, broker treats it as missing key, Ref reports error. Workspace boots normally.
- **Tool name collision when adding a third server later.** → Registered name is `<serverId>__<toolName>`; collision impossible by construction.
- **MCP SDK version pin drift.** → Pin major-only in `package.json` (`@modelcontextprotocol/sdk@^1`) so npm pulls latest 1.x on install. Patch and minor drift is in scope; major bumps require an explicit dependency change with codex review.
- **The pi extension doesn't know the backend port.** → `startServer()` writes `~/.pi-workspace/server.port`; extension reads it on boot. If the file is missing, the extension logs a warning and skips MCP registration (pi still works without it).
