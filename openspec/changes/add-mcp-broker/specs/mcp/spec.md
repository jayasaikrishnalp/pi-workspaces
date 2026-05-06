# Delta: mcp

## ADDED Requirements

### Requirement: Configured Server Catalog

The system SHALL load a static catalog of MCP servers at workspace startup. Each entry MUST be either a `stdio` config (`{id, kind:"stdio", command, args, env?}`) or an `http` config (`{id, kind:"http", url, headers?}`). For v1, the catalog is hardcoded with two entries — `ref` (HTTP) and `context7` (stdio).

The Ref API key SHALL be resolved with the following precedence: (1) `process.env.REF_API_KEY` if set; (2) the `mcpServers.Ref.headers["x-ref-api-key"]` value lifted in-memory from `~/.claude.json` if readable. The lift MUST be best-effort — a missing or malformed `~/.claude.json` MUST NOT prevent the workspace from booting; the Ref server simply reports `status:"error"`. The lifted key MUST NOT be persisted to disk by the workspace.

#### Scenario: GET /api/mcp/servers lists the seed catalog

- **GIVEN** the workspace is started with no env overrides
- **WHEN** an authenticated client sends `GET /api/mcp/servers`
- **THEN** the response status is `200`
- **AND** the body contains exactly two entries with `id` values `"ref"` and `"context7"`
- **AND** each entry has fields `{id, kind, status, toolCount}`

#### Scenario: REF_API_KEY missing AND lift fails surfaces as a per-server error, other servers unaffected

- **GIVEN** `REF_API_KEY` is not set in the operator's env
- **AND** `~/.claude.json` is unreadable or has no Ref entry
- **WHEN** a client requests `GET /api/mcp/servers`
- **THEN** the entry with `id:"ref"` has `status:"error"` and an `error` string mentioning `REF_API_KEY`
- **AND** the entry with `id:"context7"` is unaffected (status `connecting` or `connected` depending on whether it has been touched yet)

#### Scenario: Ref key auto-lifted from ~/.claude.json when env is unset

- **GIVEN** `process.env.REF_API_KEY` is unset
- **AND** `~/.claude.json` contains `mcpServers.Ref.headers["x-ref-api-key"] = "ref-test-123"`
- **WHEN** the workspace boots and Ref is touched
- **THEN** the Ref MCP request includes header `x-ref-api-key: ref-test-123`
- **AND** the workspace state file system has NOT persisted the key anywhere

### Requirement: Lazy Connection With Status Visibility

The system SHALL NOT eagerly connect MCP servers at workspace boot. Each server connects on first use (call to `getTools()` or `callTool()` for that server, or an explicit `GET /api/mcp/servers?warm=true`). The status field MUST progress through `disconnected → connecting → connected | error`. Once connected, `toolCount` MUST be the number of tools the server reports.

#### Scenario: Cold list-servers reports disconnected, no spawn

- **GIVEN** the workspace was just booted and no MCP traffic has occurred
- **WHEN** a client sends `GET /api/mcp/servers`
- **THEN** every entry has `status:"disconnected"` and `toolCount:0`
- **AND** no child process for any stdio server has been spawned

#### Scenario: First call to a stdio server triggers connect and toolCount populates

- **GIVEN** the workspace is running and `context7` is `disconnected`
- **WHEN** a client calls `GET /api/mcp/tools?server=context7`
- **THEN** the response status is `200`
- **AND** within 10 seconds a subsequent `GET /api/mcp/servers` reports `context7` as `status:"connected"` with `toolCount > 0`

### Requirement: Flat Tool List Across All Servers

The system SHALL expose `GET /api/mcp/tools` returning a flat array of every tool from every connected server, with `qualifiedName` of the form `<serverId>:<toolName>` so the same tool name across servers does not collide.

#### Scenario: Tools from two servers appear with their server prefix

- **GIVEN** both `ref` and `context7` are connected
- **WHEN** a client sends `GET /api/mcp/tools`
- **THEN** the body's `tools` array contains entries with `qualifiedName` starting with `"ref:"` and entries starting with `"context7:"`
- **AND** every entry has `{serverId, toolName, qualifiedName, description, inputSchema}`

### Requirement: Tool Call Forwarding

The system SHALL expose `POST /api/mcp/call` accepting `{serverId, toolName, args}`. The handler MUST forward to the named server, return the tool's result on success, and surface errors with HTTP status reflecting the failure mode:

- `400 UNKNOWN_SERVER` if `serverId` is not in the catalog.
- `400 UNKNOWN_TOOL` if the server doesn't expose `toolName`.
- `400 INVALID_ARGS` if the args fail the tool's input schema.
- `502 MCP_TRANSPORT_ERROR` if the underlying connection broke mid-call.
- `504 MCP_TIMEOUT` if the call exceeds 30 seconds.
- `500 INTERNAL` for anything else.

The handler MUST attach `AbortSignal.timeout(30_000)` to every call.

#### Scenario: Successful tool call returns the server's result

- **GIVEN** `ref` is connected and exposes `ref_search_documentation`
- **WHEN** a client sends `POST /api/mcp/call {serverId:"ref", toolName:"ref_search_documentation", args:{query:"MCP TypeScript SDK"}}`
- **THEN** the response status is `200`
- **AND** the body matches `{result: <object>}` with the tool's structured output

#### Scenario: Unknown server returns 400 UNKNOWN_SERVER

- **WHEN** a client sends `POST /api/mcp/call {serverId:"nope", toolName:"x", args:{}}`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"UNKNOWN_SERVER", ...}}`

#### Scenario: Tool call exceeding 30s returns 504 MCP_TIMEOUT

- **GIVEN** a stub MCP server that takes 35 seconds to respond
- **WHEN** a client sends a `POST /api/mcp/call` against it
- **THEN** within ~30 seconds the response status is `504`
- **AND** the body matches `{"error":{"code":"MCP_TIMEOUT", ...}}`
- **AND** the underlying request is aborted (no zombie connection)

### Requirement: Probe Surfaces MCP Status

The probe response SHALL include `mcp: {servers: McpServerStatus[]}` with one entry per configured server, equivalent to what `GET /api/mcp/servers` returns. This lets the dashboard render a single-glance health view without an extra request.

#### Scenario: Probe lists MCP servers alongside other capabilities

- **GIVEN** the workspace is configured with two MCP servers
- **WHEN** an authenticated client sends `GET /api/probe`
- **THEN** the response body's `mcp.servers` is an array with two entries
- **AND** each entry has `{id, kind, status, toolCount}`

### Requirement: Pi Bridge Extension Registers Tools

The system SHALL ship a pi extension at `extensions/mcp-bridge/index.ts` (in this repo, copied to `~/.pi/agent/extensions/` by `start.sh`). On `pi.on("startup")` the extension MUST:

1. Read the workspace port from `~/.pi-workspace/server.port`. If the file is missing, log a warning and exit cleanly without registering tools.
2. `GET <baseUrl>/api/mcp/tools`.
3. For each tool, call `pi.registerTool(name, handler)` where `name = "mcp__<serverId>__<toolName>"` and the handler does `POST <baseUrl>/api/mcp/call` and returns the result.

The extension MUST NOT crash pi if the workspace is unreachable; it MUST log a warning and skip registration.

#### Scenario: Extension registers Ref tools when backend is up

- **GIVEN** the workspace backend is running and `ref` is connected with two tools (`ref_search_documentation`, `ref_read_url`)
- **WHEN** pi starts and loads the extension
- **THEN** pi's tool registry includes `mcp__ref__ref_search_documentation` and `mcp__ref__ref_read_url`
- **AND** invoking `mcp__ref__ref_search_documentation` from a chat results in a successful round-trip through the backend

#### Scenario: Extension is a no-op when backend is unreachable

- **GIVEN** the workspace backend is NOT running
- **WHEN** pi starts and loads the extension
- **THEN** pi continues running normally
- **AND** the extension logs a warning that mentions the missing port file or the connection refusal
- **AND** no MCP tools are registered

### Requirement: Atomic Workspace Shutdown

When the backend HTTP server closes, the system SHALL call `mcpBroker.shutdownAll()` which:

1. Sends `SIGTERM` to every connected stdio child.
2. Waits up to 1 second for graceful exit.
3. Sends `SIGKILL` to any child that has not exited.
4. Closes every HTTP-MCP transport.

#### Scenario: Workspace shutdown leaves no zombie children

- **GIVEN** the workspace has been running with `context7` connected
- **WHEN** the operator sends SIGINT to the workspace
- **THEN** within ~2 seconds all spawned `context7` child processes have exited
- **AND** the workspace process itself exits cleanly
