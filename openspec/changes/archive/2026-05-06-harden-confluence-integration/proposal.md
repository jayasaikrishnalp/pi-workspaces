# Proposal: Confluence Integration (10-Point Hardening)

## Why

The defining demo loop is: pi misses on its KB → falls back to Confluence → answers from a cited page → operator clicks "save as skill" → next time it's a KB hit. The Confluence half of that loop is also the most exposed surface in the workspace: an HTML body fetched from a third party flows directly into the LLM context.

Spike 5 produced a working Confluence client. Codex round 3 review of that spike flagged 10 hardening items that the production loop must have:

1. Allowlist `CONFLUENCE_BASE_URL` against `^https://wkengineering\.atlassian\.net$` so a misconfigured env can't redirect lookups elsewhere.
2. Validate `pageId` as `/^\d+$/` — Atlassian page ids are numeric.
3. Redact Atlassian raw error bodies; surface only `{code, status}` to clients (the raw 5xx body sometimes leaks internal stack traces).
4. Wrap fetched page content in `<external_content trusted="false">…</external_content>` markers so the LLM sees a clear trust boundary around third-party text.
5. Accept `ATLASSIAN_API_TOKEN`, fallback to `JIRA_TOKEN` for backwards compatibility with the spike .env files.
6. 10-second `AbortSignal.timeout()` on every outbound request; no unbounded waits.
7. No full-CQL passthrough. Simple text query → server-built CQL with strict allowlisted fields. Defangs CQL injection.
8. Clamp inputs: `query` ≤ 200 chars, `limit` ∈ [1, 20], `maxChars` ∈ [256, 16000]. Defends against accidental large fetches and slowloris-style abuse.
9. Use `sanitize-html` for the page body. The spike used a regex strip; that misses styled spans and event handlers.
10. Normalize 401/403/429 to workspace error codes (`AUTH_REQUIRED`, `FORBIDDEN`, `RATE_LIMITED`); add a 5-minute in-memory cache so repeat queries don't burn the rate budget.

This change ships the hardened client + two HTTP routes that proxy to it.

## What changes

- New `confluence` capability with two endpoints:
  - `POST /api/confluence/search` — body `{query: string, limit?: number}`. Server-builds the CQL.
  - `GET /api/confluence/page/:pageId` — strict numeric pageId; returns sanitized + bounded body.
- New `src/server/confluence-client.ts` implementing all 10 hardening items.
- Domain-logic ownership: the workspace's Confluence client is what the HTTP routes call (this stage). The agent's pi-extension Confluence tool (Stage 6 will register it) reuses the SAME client. No duplicated logic.
- Probe-friendly: a startup check that resolves `BASE_URL` against the allowlist and reports a clear diagnostic if misconfigured. Stage 7 will surface this in `/api/probe`.
- Tests:
  - Unit tests for every hardening rule (allowlist, validation, sanitization, redaction, marker wrapping, cache, retry/timeout).
  - Live-pi-aware integration smoke that runs ONLY when `ATLASSIAN_API_TOKEN` (or `JIRA_TOKEN`) is set in env. Otherwise the integration suite skips the live calls cleanly.

## Scope

**In scope**
- The two routes + the client.
- All 10 hardening items.
- A live env-gated integration smoke (search "CloudOps SDK" + page fetch on the top hit).
- A malicious-page test fixture demonstrating that prompt-injection content gets wrapped in markers and stripped of script/style/event handlers.

**Out of scope**
- Writing to Confluence. Read-only.
- The agent-side pi extension that calls the client — Stage 6.
- Frontend Confluence search UI — Stage 10.
- Confluence Cloud OAuth (we use Basic auth with API tokens — what every WK SRE already has).

## Impact

- Affected specs: `confluence` (new domain).
- Affected code: `src/server/confluence-client.ts`, `src/routes/confluence.ts`, `src/server.ts` (route registration), `src/server/wiring.ts` (lazy client + cache instance).
- New deps: `sanitize-html@^2.13.0`.
- Risk level: medium. The client itself is small but the surface area is third-party HTML. Mitigation: every hardening item gets at least one targeted test plus a malicious fixture.
