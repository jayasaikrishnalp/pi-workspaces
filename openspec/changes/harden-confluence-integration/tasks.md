# Tasks: Confluence Integration (Hardened)

## 1. Client

- [x] 1.1 `src/server/confluence-client.ts` — class with `search`, `getPage`, allowlist guard, `AbortSignal.timeout`, normalized errors, in-memory LRU cache (256 cap, 5-min TTL).
- [x] 1.2 Server-built CQL: `text ~ "<escaped>" AND space.type != "personal"`.
- [x] 1.3 sanitize-html with a strict allowlist; truncate to `maxChars`.
- [x] 1.4 Wrap `getPage` content in `<external_content trusted="false" source="confluence" page-id="<id>">…</external_content>`.

## 2. Routes

- [x] 2.1 `src/routes/confluence.ts` — `POST /api/confluence/search`, `GET /api/confluence/page/:pageId`.
- [x] 2.2 Translate client error codes to HTTP status: 400 / 401 / 403 / 429 / 502 / 503 / 504.
- [x] 2.3 Register routes in `src/server.ts` + raw-URL guard for path traversal.

## 3. Wiring

- [x] 3.1 `src/server/wiring.ts` — read `ATLASSIAN_API_TOKEN` (fallback `JIRA_TOKEN`) + `ATLASSIAN_EMAIL` + `CONFLUENCE_BASE_URL`. Construct client lazily; surface a `confluenceConfigured: boolean` field.
- [x] 3.2 If allowlist fails or token is missing, the routes return `503 CONFLUENCE_UNAVAILABLE`.

## 4. Tests

- [x] 4.1 `tests/confluence-client.test.mjs` — pure unit tests with injected `fetch` mock. Coverage of all 10 hardening items.
- [x] 4.2 `tests/confluence-route.test.mjs` — route wiring, input clamps, error code translation, missing-config 503, path-traversal 400, maxChars clamp.
- [x] 4.3 `tests/integration/confluence-live.smoke.mjs` — env-gated. If creds set, run live search + page fetch. Else `# SKIP`.

## 5. Review

- [x] 5.1 Every requirement scenario backed by a test.
- [x] 5.2 Full local suite green.
- [x] 5.3 Codex review iterated to clean.
- [ ] 5.4 Markdown + PDF review bundle.
- [ ] 5.5 Three commits + push.
