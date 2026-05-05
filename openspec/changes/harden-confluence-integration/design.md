# Design: Confluence Integration (Hardened)

## Approach

A single `ConfluenceClient` class with two methods (`search`, `getPage`) and a small set of helpers. Two routes call into it. No agent-side wrapper yet (Stage 6).

```
HTTP request
   │
   ▼
routes/confluence.ts
   ├── validate pageId / clamp inputs / parse body
   ├── client.search(query, limit?)        ─►  Atlassian /wiki/rest/api/content/search
   └── client.getPage(pageId, maxChars?)   ─►  Atlassian /wiki/rest/api/content/<id>?expand=body.view
                                                                │
                                                  fetch with AbortSignal.timeout(10s)
                                                                │
                                                            (response)
                                                                │
                                              ┌─ 200 ─► sanitize-html → wrap in markers → cache → return
                                              ├─ 401 ─► AUTH_REQUIRED (redacted)
                                              ├─ 403 ─► FORBIDDEN (redacted)
                                              ├─ 429 ─► RATE_LIMITED (redacted)
                                              └─ 5xx ─► EXTERNAL_API_ERROR (redacted)
```

## Architecture

### `ConfluenceClient`

Single class, instantiated from wiring at startup:

```ts
interface ConfluenceClientOptions {
  baseUrl: string                 // must match allowlist
  email: string
  apiToken: string
  cacheTtlMs?: number             // default 5 * 60_000
  fetch?: typeof fetch            // injectable for tests
  now?: () => number              // injectable for cache TTL tests
}

class ConfluenceClient {
  search(input: { query: string; limit?: number }): Promise<SearchHit[]>
  getPage(pageId: string, maxChars?: number): Promise<{ id, title, content, sourceUrl }>
}
```

**Hardening detail:**

- **Item 1 (allowlist):** the constructor throws `INVALID_BASE_URL` if `baseUrl !== "https://wkengineering.atlassian.net"`. Wiring catches that and surfaces it as a probe diagnostic; the routes return 503 `CONFLUENCE_UNAVAILABLE`.
- **Item 2 (pageId):** `getPage` validates `/^\d+$/` and throws `INVALID_PAGE_ID` otherwise. The route catches and returns 400.
- **Item 3 (error redaction):** Atlassian's response bodies are NEVER forwarded. The client converts to `{code, status}`; the original body goes only to `console.error` for ops debugging.
- **Item 4 (markers):** every page body returned by `getPage` is wrapped in `<external_content trusted="false" source="confluence" page-id="<id>">…</external_content>`. The wrapper is part of the workspace's prompt-injection defense.
- **Item 5 (env tokens):** wiring tries `ATLASSIAN_API_TOKEN`, then `JIRA_TOKEN`. Either works. Email comes from `ATLASSIAN_EMAIL`.
- **Item 6 (timeout):** every outbound `fetch` call uses `AbortSignal.timeout(10_000)`. No client-controlled timeouts (so a malicious server can't keep us hanging).
- **Item 7 (no CQL passthrough):** `search` accepts plain text. The client builds CQL itself: `text ~ "<escaped>" AND space.type != "personal"`. The query is escaped (escape `"` and `\`).
- **Item 8 (input clamps):** `query.length` capped at 200; values longer raise `INVALID_INPUT`. `limit` clamped to `[1, 20]` (default 5). `maxChars` clamped to `[256, 16000]` (default 8000).
- **Item 9 (sanitize-html):** body is run through `sanitize-html` with `allowedTags` = `['p', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'code', 'pre', 'strong', 'em', 'br']` and `allowedAttributes` = `{ a: ['href'] }`. Everything else (script, style, on*, iframe) is stripped. Then truncated to `maxChars` with a "…" ellipsis if cut.
- **Item 10 (normalized errors + cache):** A small in-memory `Map<string, {value, expiresAt}>` cache, key = `${method}:${pageIdOrCqlHash}`. TTL = 5 min. Hit returns cached value, no outbound call. The map is bounded (max 256 entries; LRU eviction when full).

### `routes/confluence.ts`

Two handlers; both validate inputs FIRST, then call client.

```ts
POST /api/confluence/search   body: {query, limit?}
GET  /api/confluence/page/:pageId   ?maxChars=
```

Errors map to HTTP:
- `INVALID_INPUT` / `INVALID_PAGE_ID` → 400
- `INVALID_BASE_URL` (configuration) → 503
- `AUTH_REQUIRED` → 401
- `FORBIDDEN` → 403
- `RATE_LIMITED` → 429
- `EXTERNAL_API_ERROR` → 502
- `TIMEOUT` → 504
- everything else → 500 `INTERNAL`

### Test surface

- `tests/confluence-client.test.mjs` — pure unit tests with an injected `fetch` mock. Covers all 10 hardening items deterministically.
- `tests/confluence-route.test.mjs` — boots the workspace HTTP server with a fake client; verifies route mappings, input clamps, error code translation.
- `tests/integration/confluence-live.smoke.mjs` — ENV-gated. If `ATLASSIAN_API_TOKEN` (or `JIRA_TOKEN`) and `ATLASSIAN_EMAIL` are set, runs a real search + page fetch. Otherwise reports `# SKIP` and exits 0 cleanly.

## Decisions

- **Decision:** Server builds the CQL; clients only send plain text.
  **Why:** locked-spec hardening item 7. CQL injection is real — a malicious operator could exfiltrate from a different space by passing crafted CQL fragments. Server-built CQL with escaped text disables that path.

- **Decision:** sanitize-html with a tight allowlist, not a regex strip.
  **Why:** locked-spec hardening item 9. Regex-based stripping misses event handlers (`onclick`, `onmouseover`), styled spans, and CSS that can affect rendering in a UI. sanitize-html is the standard for this on Node.

- **Decision:** wrap page content in `<external_content trusted="false">` markers.
  **Why:** locked-spec hardening item 4. Even after sanitization, the LLM is still going to read this text. Wrapping it in explicit trust-boundary markers gives the system prompt a hook to instruct the model to treat the contents as data, not instructions.

- **Decision:** in-memory LRU cache with 256-entry cap, 5-min TTL.
  **Why:** the WK Atlassian instance has visible rate limits during peak hours. A repeat search on the same query inside 5 min should never burn a fresh quota slot. Bounded entries protect against memory growth from a busy session.

- **Decision:** No agent-side extension in this stage.
  **Why:** Stage 6 owns the agent integration. Stage 5 ships the client + HTTP routes so the workspace itself can search Confluence (e.g., the operator's UI) without burning an agent turn.

- **Decision:** Live integration test is env-gated, not CI-required.
  **Why:** the workspace can ship without the demo VM having Atlassian creds. The live smoke is a manual + CI-ready check that runs only when creds are present, surfaces clear `# SKIP` otherwise.

- **Decision:** Allowlist throws on construction; routes report 503 with a clear diagnostic.
  **Why:** a misconfigured `CONFLUENCE_BASE_URL` is a deploy bug, not a runtime one. Failing fast at construction surfaces it the moment the workspace boots; routes responding 503 with a typed code is what the probe page (Stage 7) will use.

## Affected files

New:
- `src/server/confluence-client.ts`
- `src/routes/confluence.ts`
- `tests/confluence-client.test.mjs`
- `tests/confluence-route.test.mjs`
- `tests/integration/confluence-live.smoke.mjs`

Modified:
- `src/server/wiring.ts` — instantiates `ConfluenceClient` from env; exposes on `Wiring`.
- `src/server.ts` — registers the two routes.
- `package.json` — `sanitize-html@^2.13.0` (added).

## Risks & mitigations

- **Risk:** sanitize-html removes useful Confluence formatting (headings, code blocks).
  **Mitigation:** the allowlist explicitly includes `h1-h4`, `code`, `pre`, `ul`, `ol`, `li`, `a[href]`. Tests assert these survive.
- **Risk:** Atlassian rate-limits us mid-demo.
  **Mitigation:** cache + clamps; the cache hit-rate during a typical demo (5–10 lookups) on a 5-min window is high.
- **Risk:** A future Atlassian endpoint shape change breaks search.
  **Mitigation:** every Atlassian-shape assumption is in `confluence-client.ts` and tested with mocked fixtures. A real-world drift surfaces as a unit test failure first, not a route 500 in production.
- **Risk:** Prompt-injection text in a page body slips past sanitize-html.
  **Mitigation:** sanitize-html removes script/style/on* but cannot stop attacker-controlled prose. The marker wrapping is the second layer; the system prompt teaches the model to treat marker-bounded text as data, not instructions.
