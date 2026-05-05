# Design: Add Server Skeleton

## Approach

Use Node 22's built-in `node:http` module — no Express, no Koa, no Hono. The workspace's traffic profile is single-tenant local dev; framework overhead has no payoff. A single `src/server.ts` file with a simple route table keeps the surface small and predictable.

Run TypeScript directly via `tsx` (no compile step) for the hackathon. Production can switch to `tsc --build` later without changing source.

## Architecture

```
src/server.ts
  ├── const ROUTES = [
  │     { method: "GET", path: "/api/health", handler: handleHealth },
  │   ]
  ├── http.createServer((req, res) => dispatch(req, res, ROUTES))
  ├── dispatch():
  │     ├── path matches a route?
  │     │     ├── method matches?         → handler(req, res)
  │     │     └── method mismatch         → 405 + Allow header
  │     └── no path match                  → 404 NOT_FOUND
  ├── handleHealth(req, res)               → 200 {ok:true, version}
  ├── jsonError(res, status, code, msg)    → standard error shape
  ├── server.listen(PORT, "127.0.0.1")
  └── installShutdown(server) — SIGTERM/SIGINT, 5s grace, exit(0)
```

Single file; route table is data, dispatch is pure. Stage 1+ moves routes to `src/routes/*.ts` once we have more than two of them.

## Data model

N/A — no persistence in Stage 0.

## Decisions

- **Decision:** Raw `node:http`, no framework
  **Alternatives:** Express, Fastify, Hono
  **Why:** Spec calls for ~3000 LoC server total; routing is <300 LoC of dispatch. Frameworks add deps and indirection without solving any real problem here. Re-visit when route count > 20.

- **Decision:** Use `tsx` for dev, no build step
  **Alternatives:** Compile with `tsc` to `dist/`, run with `node`
  **Why:** Faster iteration during the hackathon; production launcher (`start.sh`) can be swapped later.

- **Decision:** Single `src/server.ts` with inline handlers
  **Alternatives:** Pre-create `src/routes/health.ts` etc. now
  **Why:** YAGNI — Stage 1 splits routes when there are routes to split. Two routes don't need a directory.

- **Decision:** Bind to `127.0.0.1`, not `0.0.0.0`
  **Alternatives:** Bind to all interfaces by default
  **Why:** Spec says "fail-closed remote bind." Loopback default is the safe baseline; remote access goes through Tailscale or explicit later-stage config.

- **Decision:** Default port `8766`
  **Alternatives:** `3000`, `8080`, `4000`
  **Why:** `8766` matches the SSH bridge port pattern from the spike phase (`pi-lab-server.js` uses `8765`); contiguous numbering keeps the service map mentally tidy.

- **Decision:** Error JSON shape `{error: {code, message, ts}}` (matches locked spec §2.6)
  **Alternatives:** RFC 7807 `application/problem+json`, raw text
  **Why:** Locked spec §2.6 already mandates this shape for the whole product. Establishing it in Stage 0 means later stages don't have to migrate.

## Affected files & packages

| File | New / modified | Purpose |
|---|---|---|
| `package.json` | new | Node 22 type:module, scripts, devDeps tsx + @types/node + typescript |
| `tsconfig.json` | new | Strict, ES2022, NodeNext |
| `src/server.ts` | new | The whole server (~80 LoC) |
| `tests/server.smoke.mjs` | new | server-domain scenarios |
| `tests/health.smoke.mjs` | new | health-domain scenarios |
| `.gitignore` | new | `node_modules/`, `dist/`, `.env`, `runs/`, `.pi-workspace/` |
| `README.md` | new | Setup + run + smoke commands |
| `start.sh` | new | One-shot launcher (`exec node --import tsx src/server.ts`) |

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Port `8766` already in use on the VM | Test scenario covers `EADDRINUSE`; `start.sh` documents `PORT=` override |
| `SIGTERM` handler hangs on long requests | 5s timeout + `process.exit(0)` regardless |
| `tsx` not installed (production-style run) | `start.sh` invokes via `npx tsx` — works whether tsx is global or local |
| TypeScript strictness causes friction | Keep the file ≤100 LoC for now; strictness pays off in later stages |
| Tests reach an already-running server (port reuse) | Each test boots its own server on a fresh ephemeral port (use port `0` and read `server.address().port`) |
