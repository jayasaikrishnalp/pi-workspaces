# CloudOps Workspace — Build Specification (v3 — LOCKED)

> **Status:** ✅ **LOCKED** — Codex round-3 approved. Awaiting your final go-ahead to begin Stage 0.
>
> **Approval trace:**
> - v1 → Codex round-1: "not ready, 15 fixes"
> - v2 → Codex round-2: "14/15 fixed, 1 partial, 1 new" (3 remaining issues)
> - **v3 → Codex round-3: "Yes, ready to LOCK and BUILD"** ✅
>
> **Changelog v2 → v3:**
> - **§2.0:** Added `seq` (numeric int, monotonic per run) as the ordering field. `eventId` becomes the stable string id `"${runId}:${seq}"`. Backlog filtering now uses numeric `seq > afterSeq`, fixing the lex-vs-numeric bug Codex flagged.
> - **§2.0 invariant:** Scoped — only **run-scoped** events carry `seq`/`eventId`. Session-/global-scoped events (`connected`, `session.start/end`, `heartbeat`, KB events) are not replayed.
> - **§2.4 replay pseudocode:** Rewrote with single-handler, mode-flip pattern (`'queueing'` → `'streaming'`). The handler is subscribed BEFORE the drain and switches behavior in-place. No second-subscribe race, no orphaned `liveQueue`.
> - **§3 API table:** `?after=<eventId>` → `?afterSeq=<int>`; also accepts `Last-Event-ID` header.
> **Generated:** 2026-05-05 · After 5 spikes + Codex review of spike artifacts + Codex review of spec v1
> **For:** Wolters Kluwer CloudOps SREs (the SRE on call at 2am)
> **Reference:** `hermes-workspace-architecture.md`, `cobra-and-wk-ghcos-analysis.md`, `wk-agent-workspace-plan.md`
>
> **Changelog v1 → v2 (15 fixes):**
> 1. Defined `eventId` as `(runId, seq)` monotonic — replay can now work
> 2. Replay dedup by `eventId`, not `toolCallId` (deltas legitimately share toolCallId)
> 3. Added `run.start` event; `agent_start → run.start`, `turn_start → turn.start` (correct mapping)
> 4. Replay merged into `/api/runs/:runId/events?after=N` — single endpoint, atomic backlog+live
> 5. Added missing events: `user.message`, `run.start`, `run.cancelling`, `pi.error`, `model_change`, `thinking_level_change`, `session.start`, `session.end`
> 6. Mapper accepts both `toolcall_*` and `tool_call_*` spellings (resolves spike spelling drift)
> 7. `sessionKey` = pi session; added `tabId` for browser tab identity
> 8. `thinking.delta` includes `messageId` for multi-block reconstruction
> 9. Cookie-based auth (EventSource can't send Authorization headers)
> 10. Cancellation: `spawn(detached:true)` + process group kill via negative PID + SIGTERM→SIGKILL fallback + idempotent completion
> 11. Added 4 missing endpoints: `/api/confluence/page/:id`, `POST /api/skills`, `GET /api/sessions/:key/active-run`, `GET /api/runs/:runId/events`
> 12. **NEW Stage 6: Skill creation flow** — implements the demo's "save that as a skill" path
> 13. Time budgets honest: 14-15h → ~22h
> 14. Confluence hardening: 6 → 10 fixes (no full-CQL, input clamping, real HTML sanitizer, 401/403/429 + cache, no raw HTML in browser)
> 15. Memory editor cut from MVP (not needed for demo)
> 16. 12 new risks added

---

## 0. Plain-English overview

You're building **a single browser tab that does what a CloudOps SRE actually needs at 2am**: chat with an AI that knows your runbooks, watch its knowledge grow as it learns, and search internal Confluence — all without alt-tabbing.

The AI is `pi` (a local agent). The web app wraps it like `hermes-workspace` wraps `hermes-agent`. The novel part for WK is the **knowledge that compounds**: every time the AI looks up something in Confluence, it can save what it learned as a permanent skill, visible as a node in a graph, and the next person never has to ask the same question.

The 7-step demo: SRE asks a question → AI checks local skills (instant hit) → asks a harder question → KB miss → AI searches WK Confluence → answers → SRE says "save that as a skill" → AI writes a markdown file → graph animates a new node → ask the harder question again → instant answer.

**This spec defines what we build, in what order, and how each piece is tested before moving on.**

---

## 1. Architecture (3 processes)

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser (single tab)                                            │
│  Vite + Lit + Tailwind + xterm.js + D3                            │
│   - chat pane (SSE consumer w/ replay)                            │
│   - KB graph pane (D3 force layout, separate SSE)                 │
│   - confluence panel (search box + cards)                         │
│   - sidebar nav, probe banner, skill detail viewer                │
└────────────────┬───────────────────────────────────┬──────────────┘
                 │ HTTP+SSE (cookie auth)            │ WS (xterm)
                 ▼                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│  workspace server (Node, single process, ~3000 LoC)               │
│   - HTTP routes (/api/*)                                          │
│   - SSE chat-event-bus (singleton via globalThis)                 │
│   - SSE kb-event-bus (separate channel)                           │
│   - pi-rpc bridge (spawns pi --mode rpc detached as child)        │
│   - chokidar FS watcher → kb-event-bus                            │
│   - send-run-tracker + run-store (eventId-keyed; replay)          │
│   - Confluence REST client (server-side; never proxied via tool)  │
│   - Cookie-based auth middleware                                  │
└────────────────┬───────────────────────────────────┬──────────────┘
                 │ stdio JSON-line                   │ HTTPS
                 ▼                                   ▼
┌────────────────────────────────┐    ┌────────────────────────────┐
│  pi --mode rpc (child, detached)│   │  Confluence REST           │
│   - LLM agent runtime          │    │  wkengineering.atlassian   │
│   - reads .pi/skills/          │    └────────────────────────────┘
│   - persists session JSONL     │
│   - extensions:                │
│     - confluence-readonly      │
│     - agent-builder (subagent) │
└────────────────────────────────┘
```

**Reuse from the 5 spikes:**
- spike1c → `pi-rpc-bridge.ts` + `pi-event-mapper.ts`
- spike2 → `kb-browser.ts`
- spike3 → `kb-watcher.ts` + `kb-event-bus.ts`
- spike4 → `agent-builder.ts` extension (subagent spawn for skill creation)
- spike5 → `confluence-readonly.ts` extension (after hardening) + `confluence-client.ts`

---

## 2. The event contract (the spine)

### 2.0 Identifiers (the bedrock — Codex called this out)

| ID | Type | Lifetime | Source | Used for |
|---|---|---|---|---|
| `sessionKey` | string | Per pi session | Workspace assigns (UUIDv4) on first prompt | Routing pi processes |
| `tabId` | string | Per browser tab | Browser generates (UUIDv4 in sessionStorage) | Multi-tab disambiguation |
| `runId` | string | Per `prompt`/`continue`/`steer` call | Workspace generates UUIDv4 | Run lifecycle, replay key |
| `seq` | monotonic int per run, starts at 1 | Per run-scoped event | Workspace generates | Ordering + comparison (numeric) |
| `eventId` | string `"${runId}:${seq}"` (zero-padded if used in URL paths) | Per run-scoped event | Workspace generates | Stable display id, SSE `id:` field for EventSource lastEventId resume |
| `turnId` | string | Per pi `turn_start`/`turn_end` pair (multi-iter loops have multiple) | Workspace generates from `turn_start` | Group events under a turn |
| `messageId` | string | Per assistant message block | Pi assigns | Multi-block message reconstruction |
| `toolCallId` | string | Per tool call | Pi assigns (`toolu_...`) | Correlate call/exec/result |

**Invariant — scoped:** every **run-scoped** event (anything with `runId`) carries `seq` + `eventId`. **Session-/global-scoped events** (`connected`, `session.start`, `session.end`, `heartbeat`, KB events, `pi.error` not tied to a run) do NOT have `seq`/`eventId` — they aren't replayed.

**Dedup rule:** for run events, dedup ALWAYS by `seq` (numeric) — never by `toolCallId` (deltas share it by design). For non-run events, no dedup; subscribers receive at-most-once delivery from the bus.

### 2.1 Normalized SSE event names

Two separate SSE channels:

**A. Chat events (`/api/chat-events` + `/api/runs/:runId/events`):**

| Event | Payload (JSON) | Maps from pi-rpc |
|---|---|---|
| `connected` | `{sessionKey, tabId, ts}` | (synthetic; server-emitted on subscribe) |
| `session.start` | `{sessionKey, model, thinkingLevel}` | When pi spawns |
| `session.end` | `{sessionKey}` | When pi exits |
| `run.start` | `{runId, sessionKey, prompt}` | `agent_start` |
| `user.message` | `{runId, content}` | `message_end role=user` |
| `turn.start` | `{runId, turnId}` | `turn_start` |
| `assistant.start` | `{runId, turnId, messageId}` | `message_start role=assistant` |
| `assistant.delta` | `{runId, turnId, messageId, delta}` | `message_update + text_delta` |
| `thinking.start` | `{runId, turnId, messageId}` | `message_update + thinking_start` |
| `thinking.delta` | `{runId, turnId, messageId, delta}` | `message_update + thinking_delta` |
| `thinking.end` | `{runId, turnId, messageId}` | `message_update + thinking_end` |
| `tool.call.start` | `{runId, turnId, toolCallId, name}` | `message_update + toolcall_start` OR `tool_call_start` |
| `tool.call.delta` | `{runId, turnId, toolCallId, argsDelta}` | `message_update + toolcall_delta` OR `tool_call_delta` |
| `tool.call.end` | `{runId, turnId, toolCallId, name, args}` | `message_update + toolcall_end` OR `tool_call_end` |
| `tool.exec.start` | `{runId, turnId, toolCallId, name}` | `tool_execution_start` |
| `tool.exec.update` | `{runId, turnId, toolCallId, partial}` | `tool_execution_update` |
| `tool.exec.end` | `{runId, turnId, toolCallId, ok, error?}` | `tool_execution_end` |
| `tool.result` | `{runId, turnId, toolCallId, content}` | `message_end role=toolResult` |
| `assistant.completed` | `{runId, turnId, messageId, content, usage}` | `message_end role=assistant` |
| `turn.end` | `{runId, turnId}` | `turn_end` |
| `model_change` | `{runId, sessionKey, modelId, provider}` | `model_change` |
| `thinking_level_change` | `{runId, sessionKey, level}` | `thinking_level_change` |
| `pi.error` | `{runId, code, message}` | (pi error events; non-fatal) |
| `run.cancelling` | `{runId}` | (synthetic; emitted on abort request) |
| `run.completed` | `{runId, status: "success"|"cancelled"|"error", error?}` | `agent_end` OR abort timeout OR fatal error |
| `heartbeat` | `{ts}` | Every 30s on idle |

**B. KB events (`/api/kb/events` — SEPARATE channel):**

| Event | Payload | Fires when |
|---|---|---|
| `connected` | `{ts}` | Browser subscribes |
| `kb.changed` | `{kind: "add"|"change"|"unlink"|"addDir"|"unlinkDir", path, skill, ts}` | chokidar fires |
| `heartbeat` | `{ts}` | Every 30s on idle |

**Why separate:** the KB graph and the chat have different lifecycles and different consumers. Mixing them complicates filtering on both server and client.

### 2.2 Cookies and tab identity

- **Session cookie** (`workspace_session`, `httpOnly`, `SameSite=Lax`, `Secure` on prod) — issued on login, validates every request.
- **`tabId`** lives in `sessionStorage` (per-tab, not per-cookie). Browser sends it as a query param on SSE subscribe.
- **`sessionKey`** is the pi-session id. Multiple tabs can subscribe to the same `sessionKey` and receive the same event stream.

### 2.3 Pi-rpc → SSE mapping (mapper rules)

```javascript
// Mapper accepts BOTH spellings (spike1c uses tool_call_*, spike5 uses toolcall_*)
function pi_event_to_sse(piEvent, ctx) {
  switch (piEvent.type) {
    case "agent_start":  return [{ event: "run.start", data: { runId: ctx.runId, ... } }];
    case "turn_start":   return [{ event: "turn.start", data: { runId, turnId: nextTurnId() } }];
    case "message_start":
      if (piEvent.message.role === "user") return []; // covered by user.message at message_end
      if (piEvent.message.role === "assistant") return [{ event: "assistant.start", ... }];
      if (piEvent.message.role === "toolResult") return []; // covered by tool.result at message_end
    case "message_update":
      const sub = piEvent.assistantMessageEvent.type;
      // Accept both spellings
      if (sub === "text_delta") return [{ event: "assistant.delta", ... }];
      if (sub === "thinking_start") return [{ event: "thinking.start", ... }];
      if (sub === "thinking_delta") return [{ event: "thinking.delta", ... }];
      if (sub === "thinking_end") return [{ event: "thinking.end", ... }];
      if (sub === "toolcall_start" || sub === "tool_call_start") return [{ event: "tool.call.start", ... }];
      if (sub === "toolcall_delta" || sub === "tool_call_delta") return [{ event: "tool.call.delta", ... }];
      if (sub === "toolcall_end" || sub === "tool_call_end") return [{ event: "tool.call.end", ... }];
      // text_start / text_end emitted but not surfaced (UI infers)
      return [];
    case "message_end":
      if (piEvent.message.role === "user") return [{ event: "user.message", ... }];
      if (piEvent.message.role === "assistant") return [{ event: "assistant.completed", ... }];
      if (piEvent.message.role === "toolResult") return [{ event: "tool.result", ... }];
    case "tool_execution_start": return [{ event: "tool.exec.start", ... }];
    case "tool_execution_update": return [{ event: "tool.exec.update", ... }];
    case "tool_execution_end": return [{ event: "tool.exec.end", ... }];
    case "turn_end": return [{ event: "turn.end", ... }];
    case "agent_end": return [{ event: "run.completed", data: { runId, status: "success" } }];
    case "model_change": return [{ event: "model_change", ... }];
    case "thinking_level_change": return [{ event: "thinking_level_change", ... }];
    case "error": return [{ event: "pi.error", ... }];
    default: return []; // unknown; log + skip
  }
}
```

The mapper is a **pure function**. Stage 1 builds it with fixtures.

### 2.4 Replay format — atomic backlog+live

Single endpoint:
```
GET /api/runs/:runId/events?afterSeq=<int>
```
Default `afterSeq=0` (full replay from start). EventSource clients can also use the standard `Last-Event-ID` HTTP header which the server parses identically.

**Server logic (single-handler, no race):**
```javascript
async function streamRunEvents(runId, afterSeq, req, res) {
  res.writeHead(200, sseHeaders());

  let mode = 'queueing';   // 'queueing' → 'streaming'
  const queue = [];
  const seenSeqs = new Set();

  // ONE handler: queues during drain, writes after drain.
  const handler = (e) => {
    if (e.runId !== runId) return;          // filter
    if (mode === 'queueing') {
      queue.push(e);
    } else {
      if (!seenSeqs.has(e.seq)) {
        writeSse(res, e);
        seenSeqs.add(e.seq);
      }
    }
  };
  const unsub = chatEventBus.subscribe(handler);  // SUBSCRIBE FIRST

  try {
    // Drain backlog (NUMERIC compare; seq is int)
    const backlog = await runStore.getEvents(runId, { afterSeq });
    for (const e of backlog) {
      writeSse(res, e);
      seenSeqs.add(e.seq);
    }

    // Flush queue (events that arrived during drain)
    while (queue.length) {
      const e = queue.shift();
      if (!seenSeqs.has(e.seq)) {
        writeSse(res, e);
        seenSeqs.add(e.seq);
      }
    }

    // Switch to live streaming
    mode = 'streaming';
  } catch (err) {
    unsub();
    throw err;
  }

  req.on('close', () => unsub());
}
```

**Why this works:**
- The handler is installed BEFORE the drain begins — no race window.
- During the drain (`mode === 'queueing'`), live events accumulate in `queue`.
- After the drain completes, we flush `queue` (deduping by `seq`) and flip `mode` to `'streaming'`.
- Once in `'streaming'`, the SAME handler now writes directly. No second `subscribe()` call, no queue-vs-stream race.
- All comparisons on `seq` are NUMERIC (int), not string. `seq=10` correctly sorts after `seq=9`.

For initial subscribe (no replay needed — live only):
```
GET /api/chat-events?sessionKey=...&tabId=...
```
This is the "follow the live session" endpoint. Doesn't take `afterSeq`. Live tail only.

**Validation guards (Codex round-3 optional, applied for safety):**

```javascript
// Reject malformed Last-Event-ID
function parseLastEventId(header) {
  const m = /^(?<runId>[0-9a-f-]{36}):(?<seq>\d+)$/.exec(header || '');
  if (!m) return null;
  return { runId: m.groups.runId, seq: Number(m.groups.seq) };
}

// On request:
const headerLastId = parseLastEventId(req.headers['last-event-id']);
if (headerLastId && headerLastId.runId !== runId) return 400;  // wrong run

const afterSeq = Number(req.query.afterSeq ?? headerLastId?.seq ?? 0);
if (!Number.isInteger(afterSeq) || afterSeq < 0) return 400;

// run-store contract: getEvents() always returns events sorted by seq ASC
```

### 2.5 Cancellation — full process model

```
POST /api/runs/:runId/abort
   │
   ▼
1. CHECK run status; if not 'running', return 200 {already finished}
2. Mark run-store status = 'cancelling' (atomic CAS — guards against agent_end racing)
3. Emit run.cancelling event to bus
4. Send {id: "abort-<runId>", type: "abort"} to pi-rpc child stdin
5. setTimeout(3000, () => kill(-pid, "SIGTERM"))      ← negative PID = process group
6. setTimeout(4000, () => kill(-pid, "SIGKILL"))      ← if still alive
7. On clean exit OR kill: idempotently emit run.completed { status: "cancelled" }
   - Guard: if run-store status is already 'success' (agent_end arrived first),
     keep status as success and DON'T flip to cancelled
   - Guard: if run.completed already emitted, don't emit again
8. Return 204
```

**Pi spawn must use `detached: true`** so the negative-PID kill works:
```javascript
const child = spawn('pi', ['--mode', 'rpc'], {
  cwd: workspaceDir,
  stdio: ['pipe', 'pipe', 'pipe'],
  detached: true,    // OWN PROCESS GROUP — required for tree kill
  env: { ...process.env, NO_COLOR: '1' },
});
```

**Subagents inherit the process group**, so `kill(-pgid)` cleans up children too. Validated in the abort smoke test by checking `ps -ef --forest -g <pgid>` after abort.

**Abort RPC shape verified:** from `pi-mono/packages/coding-agent/src/modes/rpc/rpc-types.ts:23` — `{ id?: string; type: "abort" }`.

### 2.6 Error shape

All errors use:
```json
{ "error": { "code": "STRING_CODE", "message": "human readable", "details": { ... }, "ts": 1234567890 } }
```

Codes: `AUTH_REQUIRED`, `RUN_NOT_FOUND`, `RUN_ALREADY_RUNNING`, `INVALID_INPUT`, `EXTERNAL_API_ERROR`, `INTERNAL`.

### 2.7 Heartbeat policy

Idle SSE streams emit `{event: "heartbeat", data: {ts}}` every 30s. Required for Tailscale, nginx, Cloudflare, and any HTTP/1.1 proxy with idle timeouts.

---

## 3. HTTP API surface (MVP — 18 endpoints)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | none | Liveness ({ok, version}) |
| `POST` | `/api/auth/login` | none | Body: `{token}` (fixed dev token); sets cookie; returns `{ok}` |
| `POST` | `/api/auth/logout` | cookie | Clear cookie |
| `GET` | `/api/auth/check` | cookie | Validate session |
| `GET` | `/api/probe` | cookie | Capability matrix: pi reachable? Confluence? auth.json present? Skills loaded? |
| `GET` | `/api/sessions` | cookie | List pi sessions (per-cwd JSONL) |
| `POST` | `/api/sessions` | cookie | Create new pi session, return `{sessionKey}` |
| `GET` | `/api/sessions/:sessionKey/active-run` | cookie | `{runId, status}` if a run is in flight (refresh dedup) |
| `POST` | `/api/send-stream` | cookie | Body: `{sessionKey, message}`. Returns 202 `{runId}`. Rejects 409 if active run exists. |
| `GET` | `/api/chat-events?sessionKey=&tabId=` | cookie | SSE stream of all events for that session (live only) |
| `GET` | `/api/runs/:runId/events?afterSeq=<int>` | cookie | SSE stream with atomic backlog+live (replay-safe). Also accepts `Last-Event-ID` header. |
| `POST` | `/api/runs/:runId/abort` | cookie | Cancel a run |
| `GET` | `/api/kb/graph` | cookie | `{nodes, edges, diagnostics}` JSON for D3 |
| `GET` | `/api/kb/events?tabId=` | cookie | SSE stream of FS changes (separate from chat) |
| `GET` | `/api/kb/skill/:name` | cookie | Read SKILL.md content (path-traversal guarded) |
| `POST` | `/api/skills` | cookie | Body: `{name, content}`. Creates `.pi/skills/<name>/SKILL.md` atomically (via subagent OR direct write). |
| `POST` | `/api/confluence/search` | cookie | Body: `{query, limit?}`. Server-side REST (no agent tool indirection). |
| `GET` | `/api/confluence/page/:pageId` | cookie | Read a Confluence page (validated as `/^\d+$/`). |

**18 endpoints total.** Memory endpoints removed (Stage cut from MVP).

**Cookie auth note:** EventSource only sends cookies. Login flow:
1. `POST /api/auth/login {token: "<fixed-dev-token>"}` → server validates, sets `Set-Cookie: workspace_session=<random>; HttpOnly; SameSite=Lax`
2. All subsequent requests automatically carry the cookie
3. EventSource subscribes work without manual headers
4. For local dev, single-user, `fixed-dev-token` is in `~/.pi-workspace/dev-token.txt` (mode 0600)

**Domain-logic ownership:**
- The **server's Confluence client** is what `/api/confluence/*` calls — direct HTTPS, no pi indirection.
- The **agent's Confluence tools** (the extension) are what pi calls when reasoning. Same backend, separate caller.
- This means a browser Confluence search doesn't burn an agent turn.

---

## 4. File & directory layout

### 4.1 On the VM (development + runtime)

```
~/pi-workspace-server/                        ← NEW (separate from spikes/)
├── package.json                              (Node 22, type: module)
├── tsconfig.json
├── .gitignore
├── README.md
├── start.sh                                  (one-shot launcher)
├── src/
│   ├── server.ts                             ← entry: HTTP + WS
│   ├── routes/
│   │   ├── auth.ts                           (login/logout/check)
│   │   ├── probe.ts                          (capability matrix)
│   │   ├── sessions.ts                       (list/create + active-run)
│   │   ├── send-stream.ts                    (POST /api/send-stream)
│   │   ├── chat-events.ts                    (SSE — live only)
│   │   ├── runs.ts                           (events?after=, abort)
│   │   ├── kb.ts                             (graph, events, skill)
│   │   ├── skills.ts                         (POST /api/skills — create)
│   │   └── confluence.ts                     (search, page/:id)
│   ├── server/
│   │   ├── pi-rpc-bridge.ts                  (spawn detached, JSON-line framing)
│   │   ├── pi-event-mapper.ts                (raw pi → normalized SSE; pure fn)
│   │   ├── chat-event-bus.ts                 (singleton on globalThis)
│   │   ├── kb-event-bus.ts                   (separate singleton)
│   │   ├── send-run-tracker.ts               (active run dedup)
│   │   ├── run-store.ts                      (~/.pi-workspace/runs/<id>.json + atomic CAS)
│   │   ├── kb-browser.ts                     (graph builder)
│   │   ├── kb-watcher.ts                     (chokidar)
│   │   ├── confluence-client.ts              (REST, retry, cache, redaction)
│   │   ├── auth-middleware.ts                (cookie validation)
│   │   └── env-loader.ts                     (uses dotenv, not homemade)
│   └── types/
│       └── events.ts                         (TypeScript types for the contract)
├── extensions/                               (loaded by pi --extension <path>)
│   ├── confluence-readonly.ts                (HARDENED — 10 fixes)
│   └── agent-builder.ts                      (NEW — subagent spawner from spike4)
├── seed-skills/                              (5 SKILL.md files for the demo)
│   ├── reboot-server/SKILL.md
│   ├── check-server-health/SKILL.md
│   ├── aws-cleanup/SKILL.md
│   ├── patch-vm/SKILL.md
│   └── disk-cleanup/SKILL.md
├── fixtures/                                 ← test fixtures the user reviews
│   ├── pi-events-text-turn.jsonl
│   ├── pi-events-tool-turn.jsonl
│   ├── sse-events-text-turn.jsonl            (expected normalized output)
│   ├── sse-events-tool-turn.jsonl            (expected normalized output)
│   ├── kb-graph-seed.json                    (5-skill expected graph)
│   ├── confluence-401.json                   (mocked error responses)
│   ├── confluence-403.json
│   ├── confluence-429.json
│   └── confluence-malicious-page.json        (prompt-injection sample)
├── tests/
│   ├── pi-event-mapper.test.mjs              (unit: each pi event → expected SSE)
│   ├── send-stream.smoke.mjs                 (e2e: curl-based)
│   ├── replay.smoke.mjs                      (e2e: simulate refresh, both orderings)
│   ├── abort.smoke.mjs                       (e2e: cancel mid-run, verify pgid clean)
│   ├── kb-graph.smoke.mjs                    (e2e: drop file, observe SSE)
│   ├── confluence.smoke.mjs                  (e2e: search + page; uses fixtures + live)
│   ├── skill-creation.smoke.mjs              (e2e: full demo path)
│   └── all-stages.smoke.mjs                  (e2e: regression after Stage 7+)
└── frontend/                                 ← built in stage 8+
    ├── index.html
    ├── vite.config.ts
    └── src/...
```

### 4.2 Persistent state

```
~/.pi/agent/                                  (pi's own state)
├── auth.json                                 (Copilot OAuth)
├── .env                                      (Confluence creds: ATLASSIAN_API_TOKEN, CONFLUENCE_EMAIL, CONFLUENCE_BASE_URL)
└── sessions/<encoded-cwd>/*.jsonl

~/.pi-workspace/                              ← NEW (workspace runtime state)
├── dev-token.txt                             (single-user dev token, mode 0600)
├── sessions.json                             (workspace cookie sessions, mode 0600)
├── runs/<runId>.json                         (run-store: replay history, monotonic eventId)
└── overrides.json                            (URL overrides for pi-rpc, future)
```

---

## 5. Dependencies (pinned)

```json
{
  "name": "pi-workspace-server",
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "dependencies": {
    "ws": "^8.19.0",
    "chokidar": "^4.0.0",
    "@sinclair/typebox": "^0.34.0",
    "dotenv": "^16.4.0",
    "sanitize-html": "^2.13.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.10.0"
  }
}
```

`sanitize-html` is the real HTML sanitizer for Confluence content (Codex flagged regex-only as inadequate).

**No web frameworks.** Raw Node `http` + `ws` + cookies. We're <300 LoC of routing.

---

## 6. Stage plan (12 stages, ~22h)

Each stage = development + test + user-reviewed test data + commit. **Nothing skips.**

### Stage 0 — Workspace skeleton (~30 min)

| | |
|---|---|
| Goal | Empty server boots; `npm run dev` returns ok on `/api/health` |
| Files created | `package.json`, `tsconfig.json`, `.gitignore`, `README.md`, `src/server.ts` |
| Tests | `tests/health.smoke.mjs`: `curl /api/health` → `{ok: true, version: "0.1.0"}` |
| Test data for user | The curl output |
| Commit message | `stage 0: server skeleton + healthcheck` |

### Stage 1 — Pi event mapper + fixtures (~1.5h)

| | |
|---|---|
| Goal | Pure function mapping raw pi events → normalized SSE events. Accepts both `toolcall_*` and `tool_call_*` spellings. |
| Files | `src/server/pi-event-mapper.ts`, `src/types/events.ts`, `tests/pi-event-mapper.test.mjs`, `fixtures/pi-events-*.jsonl`, `fixtures/sse-events-*.jsonl` |
| Tests | Replay both fixture sets through the mapper; assert byte-equal output to expected SSE fixtures |
| Test data for user | **Annotated event timeline:** for each raw pi event, show the input, the mapper output, and a one-line "why" explanation. |
| Commit | `stage 1: pi event mapper + annotated fixtures` |

### Stage 2 — Pi-rpc bridge + bus + run-store (~5h)

**Largest stage. Most risk.** Codex's verdict: "the highest-risk slice."

| | |
|---|---|
| Goal | `POST /api/send-stream` spawns/reuses pi-rpc child (detached), writes events to bus + run-store with monotonic `eventId`. `GET /api/runs/:runId/events?after=N` does atomic backlog+live replay. |
| Files | `src/server/pi-rpc-bridge.ts`, `src/server/chat-event-bus.ts`, `src/server/send-run-tracker.ts`, `src/server/run-store.ts`, `src/routes/send-stream.ts`, `src/routes/runs.ts`, `src/routes/sessions.ts` |
| Tests | `tests/send-stream.smoke.mjs`: 1) POST a prompt, 2) open `/api/runs/:id/events`, 3) verify all expected events arrive, 4) check eventIds are monotonic and unique. `tests/replay.smoke.mjs`: TWO orderings — (a) "SSE before POST → live capture", (b) "POST before SSE → replay must include all events from start". Both must pass. |
| Test data for user | Side-by-side diff of (a) ordering and (b) ordering — both must reach identical final state. Plus eventId table with no gaps/duplicates. |
| Commit | `stage 2: pi-rpc bridge with eventId-keyed atomic replay` |

### Stage 3 — Cancellation (~1.5h)

| | |
|---|---|
| Goal | `POST /api/runs/:id/abort` cleanly stops a running pi-rpc turn AND its subagents, idempotently. Process group kill via negative PID. |
| Files | Extend `pi-rpc-bridge.ts` (abort method); extend `runs.ts` (abort route); extend `run-store.ts` (atomic status CAS) |
| Tests | `tests/abort.smoke.mjs`: 1) start a long prompt that spawns a subagent, 2) abort after 2s, 3) verify `run.completed { status: "cancelled" }`, 4) check `ps -ef --forest -g <pgid>` shows zero descendants, 5) idempotency: send abort twice → second is 200 + "already cancelled". |
| Test data for user | Process tree before abort + after abort + idempotency log. PIDs visible. |
| Commit | `stage 3: clean run cancellation with process group kill` |

### Stage 4 — KB graph + watcher (~1.5h)

| | |
|---|---|
| Goal | `GET /api/kb/graph` returns nodes/edges. `GET /api/kb/events` streams FS changes on a SEPARATE bus from chat. |
| Files | `src/server/kb-browser.ts` (from spike2), `src/server/kb-watcher.ts` (from spike3), `src/server/kb-event-bus.ts`, `src/routes/kb.ts`, 5 seed SKILL.md files in `seed-skills/` |
| Tests | `tests/kb-graph.smoke.mjs`: 1) GET graph → expect 5 nodes from seed, 2) drop a 6th SKILL.md, 3) verify SSE event within 200ms, 4) re-GET graph → 6 nodes. PLUS edge cases: malformed YAML, dangling wikilink, deleted skill, partial-write race (verify `awaitWriteFinish` works). |
| Test data for user | Graph JSON for the 5 seeds + SSE event sequence + edge-case fixtures (each producing the expected diagnostic). |
| Commit | `stage 4: kb graph + live watcher (separate bus)` |

### Stage 5 — Confluence (HARDENED) (~3h)

| | |
|---|---|
| Goal | `POST /api/confluence/search` and `GET /api/confluence/page/:pageId` proxy to a hardened version of the spike5 extension. **Apply 10 fixes from Codex review.** |
| Files | `extensions/confluence-readonly.ts` (rewritten), `src/server/confluence-client.ts`, `src/routes/confluence.ts` |
| Hardening fixes (10) | 1) Allowlist `CONFLUENCE_BASE_URL` against `^https://wkengineering\.atlassian\.net$`. 2) Validate `pageId` as `/^\d+$/`. 3) Redact Atlassian raw error bodies — generic message + status only. 4) Wrap page content in `<external_content trusted="false">…</external_content>` markers. 5) Accept `ATLASSIAN_API_TOKEN`, fallback `JIRA_TOKEN`. 6) 10s `AbortSignal.timeout()`. 7) **No full-CQL passthrough** — simple text only OR strict allowlisted CQL fields. 8) Clamp inputs: `query` ≤ 200 chars, `limit` ∈ [1,20], `maxChars` ∈ [256, 16000]. 9) Use `sanitize-html` for body, not regex. 10) 401/403/429 handled with normalized error codes; 5-min in-memory cache. |
| Tests | `tests/confluence.smoke.mjs`: 1) live search "COBRA SDK" returns ≥1 result, 2) get_page on top result returns content with prompt-injection markers, 3) `pageId="../../etc/passwd"` returns 400, 4) bad base URL → tool stays disabled with clear probe, 5) mocked 401/403/429 return normalized errors, 6) malicious page content (test fixture with injected `Ignore previous instructions...`) is delivered with markers but not interpreted. |
| Test data for user | Live search result + redacted error sample + malicious-page test showing the wrapping markers. |
| Commit | `stage 5: confluence integration (10-point hardening)` |

### **NEW Stage 6 — Skill creation flow (~3h) ← Codex-mandated**

| | |
|---|---|
| Goal | Implement the demo's "save that as a skill" path end-to-end. `POST /api/skills` invokes the agent-builder extension's subagent which writes a SKILL.md atomically; chokidar fires `kb.changed`; replayed graph reflects the new skill; subsequent prompts hit the new skill (no Confluence call). |
| Files | `extensions/agent-builder.ts` (registers `create_skill` tool — wraps spike4), `src/routes/skills.ts` (POST /api/skills), `tests/skill-creation.smoke.mjs` |
| Architecture | Two paths to write a skill: <br> **(a) From chat** — agent calls `create_skill(name, content)` tool; the extension's `execute()` writes `.pi/skills/<name>/SKILL.md` atomically via tmpfile + rename. <br> **(b) From server** — `POST /api/skills {name, content}` validates name (`/^[a-z][a-z0-9-]+$/`, ≤ 64 chars), writes the same file. Both paths converge on the same atomic-write helper. |
| Tests | `tests/skill-creation.smoke.mjs`: **the full demo path:** 1) Send a Confluence-search prompt, observe agent calls `confluence_search` + `confluence_get_page`. 2) Send "save that as a skill" — observe agent calls `create_skill`, file appears in `.pi/skills/`. 3) Verify `kb.changed` SSE event arrives. 4) GET `/api/kb/graph` → new node present. 5) Send the original Confluence question again — verify NO `confluence_search` call (KB hit instead). |
| Test data for user | The full multi-turn transcript + the generated SKILL.md content + the kb.changed SSE event + the re-ask transcript proving no Confluence call. **This is the demo, captured.** |
| Commit | `stage 6: skill creation flow (the demo's save-as-skill path)` |

### Stage 7 — Probe + auth (~1h)

| | |
|---|---|
| Goal | `/api/probe` returns capability matrix; cookie-based auth gates everything else; session tokens persist across server restart. |
| Files | `src/server/auth-middleware.ts`, `src/routes/auth.ts`, `src/routes/probe.ts` |
| Tests | 1) Unauthed request to `/api/probe` → 401, 2) login → cookie issued, 3) `/api/probe` → JSON with all capabilities (pi/Confluence/auth.json/skills count/run-store size), 4) restart server → cookie still valid. **Regression: re-run all Stage 0-6 smoke tests with cookie auth applied.** |
| Test data for user | The probe JSON + the cookie set/validated trace. Confirms feature gates for the UI. |
| Commit | `stage 7: probe + cookie-based auth` |

### Stage 8 — Frontend shell + chat (~3h)

| | |
|---|---|
| Goal | Vite + Lit + Tailwind boots; sidebar + chat pane visible; chat connects to `/api/runs/:runId/events`; messages stream live with replay-on-refresh working. |
| Files | `frontend/index.html`, `frontend/vite.config.ts`, `frontend/src/main.ts`, `frontend/src/shell.ts`, `frontend/src/components/Sidebar.ts`, `frontend/src/components/ChatPane.ts`, `frontend/src/lib/api.ts`, `frontend/src/lib/chat-stream.ts`, `frontend/src/stores/session.ts` |
| Tests | Manual: open browser → see sidebar + chat → type "say OK" → see assistant text stream in. Refresh mid-stream → see replay catch up. Plus a Playwright smoke as time permits (optional). |
| Test data for user | Screenshot before/after refresh — text identical. |
| Commit | `stage 8: frontend shell + live chat with replay` |

### Stage 9 — KB graph component (~3h)

| | |
|---|---|
| Goal | D3 force layout in browser; subscribes to `/api/kb/events`; new node animates in when SKILL.md is dropped. Click node → SkillDetail. |
| Files | `frontend/src/components/KbGraph.ts`, `frontend/src/components/SkillDetail.ts`, `frontend/src/lib/kb-stream.ts`, `frontend/src/stores/kb.ts` |
| Tests | Manual: open browser → see 5 seed nodes; from terminal drop a 6th SKILL.md; node animates in within 1s; click node → SkillDetail renders. |
| Test data for user | Screenshot of graph before/after + SkillDetail rendering. |
| Commit | `stage 9: kb graph ui with live updates` |

### Stage 10 — Confluence panel (~1.5h)

| | |
|---|---|
| Goal | Confluence tab opens a search box + result cards. Click result → renders body (sanitized). Search button calls server `POST /api/confluence/search`. |
| Files | `frontend/src/components/ConfluencePanel.ts` |
| Tests | Manual: search "COBRA SDK" → 5 results render → click top → body renders with sanitized content (no script tags, no raw HTML). |
| Test data for user | Screenshot of search + page render. |
| Commit | `stage 10: confluence panel ui` |

### Stage 11 — Demo polish + README (~1.5h)

| | |
|---|---|
| Goal | Demo script runs cleanly 3x in a row; README explains setup; `start.sh` boots everything. |
| Files | `README.md`, `start.sh`, the seed skills (already created), demo recording |
| Tests | Run the 7-step demo end-to-end. All steps pass. |
| Test data for user | Loom video / screen recording of the full demo. |
| Commit | `stage 11: demo polish + README` |

**Total estimated: ~22h** (was 14-15h in v1; Codex called this unrealistic).

**Memory editor (was Stage 9 in v1) cut from MVP** — not on the demo path. Defer to phase 2.

---

## 7. Git workflow

```
~/pi-workspace-server/
├── git init
├── main branch only (no PRs for hackathon)
├── ONE commit per stage (12 commits total)
├── commit message: "stage N: <one-line summary>"
├── .gitignore: node_modules/, .env, dist/, runs/, .pi-workspace/
└── (optional) push to private GitHub repo at end
```

**Rule:** never start stage N+1 until stage N is committed.

If a stage's test fails:
1. Fix the bug
2. Re-run the test
3. THEN commit (no broken commits)

---

## 8. Test data review process (the human gate)

After each stage's tests pass, I produce a **plain-English review document** with:

| Section | Content |
|---|---|
| **What this stage built** (1 paragraph in layman terms) | "We built the layer that translates pi's internal events into a stable wire format the browser will consume…" |
| **What the test data shows** (with side-by-side diffs / annotated timelines / process trees) | Show the input, output, and why they match expectations |
| **Anything weird I noticed** | Edge cases that work but feel fragile; future cleanup |
| **Confidence level** | High / medium / low + why |
| **Sign-off prompt** | "Approve to commit + proceed to stage N+1?" |

You read it, eyeball the data, say go or push back. **Only on your "go" do I commit and start the next stage.**

---

## 9. Risks (now 25 items — Codex added 12)

| # | Risk | Mitigation |
|---|---|---|
| 1 | Pi-rpc child crashes mid-run, replay corrupts | Atomic writes (.tmp + rename); on resume, validate JSON |
| 2 | Two browser tabs send simultaneous prompts | send-run-tracker rejects 2nd send while first active (409) |
| 3 | Confluence rate-limit during demo | 5-min in-memory cache (added in Stage 5) |
| 4 | chokidar miss on macOS Network folders | Demo on local disk only |
| 5 | Vite HMR breaks the singleton bus | `globalThis` survival pattern |
| 6 | Long-running prompt times out (Tailscale 2-min idle) | 30s heartbeats |
| 7 | Subagent spawn fails (env issue) | Catch + emit `tool.exec.end {ok:false, error}` |
| 8 | Demo VM dies mid-presentation | Screen recording as backup |
| 9 | **NEW** Pi RPC protocol drift / spelling drift | Mapper accepts both `toolcall_*` and `tool_call_*`; tested on both fixtures |
| 10 | **NEW** Replay gap due to non-atomic backlog→live handoff | Subscribe-before-drain pattern (Section 2.4) |
| 11 | **NEW** EventSource auth limitations | Cookie-based auth; no token in query params |
| 12 | **NEW** Process-group kill failure / orphaned subagents | `spawn(detached:true)` + `kill(-pgid)` + verify with `ps --forest` in test |
| 13 | **NEW** Confluence prompt injection from page content | Wrap in `<external_content trusted="false">` markers |
| 14 | **NEW** Confluence XSS via raw HTML in browser | `sanitize-html` server-side before sending to UI |
| 15 | **NEW** Confluence CQL injection | No full-CQL passthrough; whitelist of safe fields only |
| 16 | **NEW** Path traversal in `/api/kb/skill/:name` | Validate name `/^[a-z][a-z0-9-]+$/`, ≤ 64 chars; resolve and assert under skills root |
| 17 | **NEW** Raw HTTP body-size / malformed JSON / method handling bugs | Body size cap (1MB); content-type required; explicit method allowlist per route |
| 18 | **NEW** Run-store disk growth | Retention: keep last 100 runs OR 7 days; cleanup at startup + every hour |
| 19 | **NEW** First-run pi auth/model failure despite probe | Probe checks BOTH `auth.json` exists AND `pi --list-models` returns ≥1 model |
| 20 | **NEW** Watcher partial-write race (subagent writing SKILL.md) | chokidar `awaitWriteFinish: { stabilityThreshold: 100 }`; subagent uses tmpfile + rename |
| 21 | **NEW** Seed skills fire destructive ops in demo | All seed skills include "DRY-RUN ONLY" frontmatter + body warning |
| 22 | **NEW** Idempotency races on run completion | Run-store has atomic CAS; status state machine `running → cancelling → cancelled` is one-way |
| 23 | **NEW** Multi-tab sees stale active-run | `/api/sessions/:key/active-run` returned by server is source of truth; tabs reconcile on connect |
| 24 | **NEW** Cookie session theft on shared machine | Single-user local; production would need stronger auth |
| 25 | **NEW** Server restart loses in-flight runs | Run-store persists; on restart, mark in-flight runs as "interrupted" |

---

## 10. Out of scope (explicit cuts for this hackathon)

- Multi-user / SSO / RBAC
- Real session-token issuance flow (using fixed dev token)
- Conductor / Swarm / Tasks / Pipelines tabs
- TanStack Start (using Vite + Lit)
- Monaco editor (skill detail uses rendered markdown)
- **Memory editor** (was Stage 9 v1; cut)
- xterm terminal panel (deferred — was implied by architecture but never had a stage)
- PWA install
- Electron desktop build
- Persistent skill store / git-sync
- Cobra MCP federation (waits for `wk-gbs` access)
- Self-update
- Tests beyond smoke (no full unit-test suite)

---

## 11. Definition of "done" for the whole project

A new SRE clones the repo, runs `bash start.sh`, opens the browser, and successfully completes the 7-step demo (KB hit → KB miss → Confluence fallback → save as skill → graph updates → KB hit on re-ask) in under 5 minutes, end-to-end, on the live VM.

If that works, we ship.

---

## 12. Spec sign-off process

1. ✅ **You** read v1, approved direction.
2. ✅ **Codex** reviewed v1, returned "not ready to lock" + 15 fixes.
3. **You** read v2 (this doc).
4. **Codex** reviews v2 — round 2.
5. After Codex approves (or after we apply round-2 fixes), spec is **frozen**. Stages 0-11 begin.
6. If anything in the spec needs changing during build, we re-spec that section first, then change code.

---

**This is v2. Awaiting Codex round-2 review + your final approval. No code yet.**
