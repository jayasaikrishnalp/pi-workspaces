# Proposal: Add HTTP Server Skeleton with Health Endpoint

## Why

CloudOps Workspace is a greenfield project. Before any chat, knowledge graph, or Confluence integration can be built, we need a minimal HTTP server we can boot, hit, and verify. Stage 0 establishes the foundation: a Node 22 + TypeScript HTTP server with a single liveness endpoint.

This is the smallest unit of deployable progress. Every subsequent stage layers on top of it, and the locked product spec (v3) requires that we never start a stage until the previous stage is committed and tested.

## What changes

- Add an HTTP server that binds to a configurable port and serves the workspace.
- Add a `GET /api/health` endpoint that returns liveness status without authentication.
- Add a 404 fallback for unknown paths and a 405 fallback for wrong methods.
- Add a `SIGTERM`/`SIGINT` graceful shutdown path.

## Scope

**In scope**
- HTTP server boot/shutdown with port configuration
- `GET /api/health` endpoint
- Method allowlisting per route (405 on wrong method)
- 404 for unknown paths
- Graceful shutdown
- Smoke tests covering each scenario in the delta specs

**Out of scope** (explicitly parked for later changes)
- Authentication / cookies (Stage 7 — `add-probe-and-auth`)
- Any other endpoints (Stages 1+)
- TLS termination (out of MVP)
- Body-size limits / rate limiting (Stage 7)
- Request logging beyond startup line (later)

## Impact

- Affected specs: `server`, `health`
- Affected code areas: `package.json`, `tsconfig.json`, `src/server.ts`, `tests/*.smoke.mjs`, `.gitignore`, `README.md` (informational; real detail in `design.md`)
- Risk level: **low**

This change is intentionally tiny. The risk is over-engineering, not under-engineering. If a feature is worth ≥1 hour of work, it goes in a later change.
