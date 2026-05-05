# Proposal: Probe + Cookie Auth

## Why

The workspace is single-user but it's deployed somewhere reachable (local laptop or Tailscale-exposed VM). Anyone who can hit the port shouldn't get to drive pi or read run-store contents. Stage 7 closes that gap with the smallest workable auth: a cookie issued by a single dev token, validated by every protected route. EventSource only sends cookies — query-string tokens or `Authorization` headers wouldn't survive the SSE handshake — so cookies are the only mechanism that actually works for our two SSE channels.

A second deliverable in this stage: `/api/probe` reports the workspace's capability matrix — pi reachable? Confluence configured? skills count? auth.json present? — so the frontend (Stage 8) can render a sensible startup screen instead of trial-and-error.

## What changes

- New `auth` capability:
  - Read a fixed dev token from `~/.pi-workspace/dev-token.txt` (mode 0600); if missing on first boot, generate and persist one.
  - `POST /api/auth/login {token}` — validates, sets `Set-Cookie: workspace_session=<random-uuid>; HttpOnly; SameSite=Lax; Path=/`. Tracks the session in memory.
  - `POST /api/auth/logout` — clears the cookie.
  - `GET /api/auth/check` — returns `{ok:true}` if cookie validates, else 401.
  - Middleware: every existing route except `/api/health`, `/api/auth/login`, and `/api/auth/check` requires a valid cookie. Missing/invalid cookie → 401 `AUTH_REQUIRED`.
- New `probe` capability:
  - `GET /api/probe` — returns `{pi:{ok, version?}, confluence:{ok, configured, error?}, skills:{count}, auth:{piAuthJsonPresent}}`.
  - Cookie-gated like the rest.
- Sessions persist across server restart by storing the issued cookie value in `~/.pi-workspace/sessions.json` (mode 0600). One session at a time is the MVP; multi-cookie tracking is a future change.
- Existing tests run unchanged; the test harness's HTTP boot now includes a "test mode" bypass: when `PI_WORKSPACE_AUTH_DISABLED=1` is set, the middleware is skipped. All Stage 0–6 tests run with that flag set so they don't have to thread auth through every assertion.

## Scope

**In scope**
- The `auth` middleware + the four routes above.
- `GET /api/probe` matrix.
- Persistent session across restart.
- Integration: `start.sh` (or a one-shot helper) prints the dev token to stdout on first boot for the operator to copy.
- Tests: middleware blocks unauth + permits authed; login → cookie → check; restart preserves session; probe contents shape.

**Out of scope**
- Real multi-user auth, OAuth, RBAC.
- Per-route ACL beyond the public-vs-private split.
- Token rotation (the dev-token.txt file holds one value; you delete the file to rotate).
- Rate limiting on login.

## Impact

- Affected specs: `auth` (new), `probe` (new).
- Affected code: `src/server/auth-middleware.ts`, `src/routes/auth.ts`, `src/routes/probe.ts`, `src/server.ts` (middleware integration), `src/server/wiring.ts` (loads dev token + session store), tests.
- Risk level: medium — the middleware change touches every existing route; we mitigate with the `PI_WORKSPACE_AUTH_DISABLED` test-mode bypass + a regression smoke that re-runs a representative sample with auth enabled.
