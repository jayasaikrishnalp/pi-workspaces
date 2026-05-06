# Tasks: Add Server Skeleton

> Each task is a single commit-sized step. Boxes get checked as we work top-to-bottom.

## 1. Project bootstrap

- [x] 1.1 On the VM, create `~/pi-workspace-server/`, `cd` in, `git init`, set `git config user.email` + `user.name` if missing
- [x] 1.2 Add `.gitignore`: `node_modules/`, `dist/`, `.env`, `.pi-workspace/`, `runs/`, `*.log`
- [x] 1.3 Sync the OpenSpec structure from Mac (`openspec/AGENTS.md`, `openspec/specs/` empty, `openspec/changes/add-server-skeleton/` with all 4+2 artifacts) → commit as `openspec: bootstrap + propose add-server-skeleton`
- [x] 1.4 (Mac) keep this same dir in sync as the canonical OpenSpec source

## 2. Package + tooling setup

- [x] 2.1 `npm init -y`; edit `package.json`: `name=pi-workspace-server`, `version=0.1.0`, `type=module`, `engines.node=>=22.0.0`
- [x] 2.2 Install dev deps: `npm i -D tsx typescript @types/node`
- [x] 2.3 Add `tsconfig.json` (strict, target ES2022, module NodeNext, moduleResolution NodeNext, rootDir src)
- [x] 2.4 Add npm scripts: `dev` (tsx watch src/server.ts), `start` (tsx src/server.ts), `test:smoke` (node --test tests/*.smoke.mjs OR a runner script)
- [x] 2.5 Add `start.sh` one-shot launcher (`#!/usr/bin/env bash; exec npx tsx src/server.ts`)

## 3. Implementation (server.ts)

- [x] 3.1 `src/server.ts`: import `node:http`, define `VERSION = "0.1.0"`, define `ROUTES` table
- [x] 3.2 Implement `handleHealth(req, res)` returning 200 + `{ok:true, version}` JSON
- [x] 3.3 Implement `jsonError(res, status, code, message)` matching the locked-spec error shape
- [x] 3.4 Implement `dispatch(req, res)`: path-then-method match; 404 on no path match; 405 + Allow header on path-but-wrong-method
- [x] 3.5 Read `PORT` from env (default `8766`); bind to `127.0.0.1`
- [x] 3.6 Log startup line: `[server] listening on http://127.0.0.1:<port> (v<VERSION>)`
- [x] 3.7 Install `SIGTERM`/`SIGINT` handlers — close server, force `process.exit(0)` after 5s

## 4. Tests (one per delta-spec scenario)

> Each test maps 1:1 to a `Scenario:` block in the delta specs. The mapping MUST be explicit in the test name.

### 4a. server-domain scenarios → tests/server.smoke.mjs

- [x] 4.1 `server: boots on configured port` — start with PORT=0, read bound port, assert listening
- [x] 4.2 `server: default port when PORT unset` — start with PORT unset, expect 8766 (skip if 8766 occupied; document why)
- [x] 4.3 `server: port collision exits non-zero with EADDRINUSE` — pre-bind 8766, spawn server, expect exit !=0 and stderr contains "EADDRINUSE"
- [x] 4.4 `server: SIGTERM exits cleanly within 5s` — start, send SIGTERM, expect exit code 0 within 5s
- [x] 4.5 `server: SIGINT exits cleanly within 5s` — start, send SIGINT, expect exit code 0 within 5s
- [x] 4.6 `server: unknown path returns structured 404` — `GET /api/does-not-exist` → 200 status check FAILS, expect 404 JSON shape, Content-Type=application/json

### 4b. health-domain scenarios → tests/health.smoke.mjs

- [x] 4.7 `health: healthy response shape` — `GET /api/health` → 200, body `{ok:true, version:<semver>}`, Content-Type=application/json
- [x] 4.8 `health: endpoint requires no authentication` — `GET /api/health` with no Cookie/Authorization → 200 (not 401)
- [x] 4.9 `health: wrong method returns 405` — `POST /api/health` → 405, Allow: GET, body matches METHOD_NOT_ALLOWED shape

## 5. Documentation

- [x] 5.1 `README.md`: prerequisites (Node ≥22), install (`npm i`), run (`./start.sh` or `npm run dev`), test (`npm run test:smoke`), env vars (`PORT`)
- [x] 5.2 README cross-references `openspec/AGENTS.md`

## 6. Verification

- [x] 6.1 All 9 tests pass
- [x] 6.2 Every `Scenario:` in `openspec/changes/add-server-skeleton/specs/server/spec.md` maps to a passing test
- [x] 6.3 Every `Scenario:` in `openspec/changes/add-server-skeleton/specs/health/spec.md` maps to a passing test
- [x] 6.4 No TODO/FIXME comments introduced
- [x] 6.5 All decisions in `design.md` are reflected in the code
- [x] 6.6 `start.sh` boots cleanly; `curl http://127.0.0.1:8766/api/health` returns the expected JSON

## 7. Human review + commit

- [x] 7.1 Generate test data summary in plain English (per locked-spec §8): annotated curl outputs + test pass/fail table
- [x] 7.2 Human reviews and approves
- [x] 7.3 Single commit on approval: `stage 0: server skeleton + health (openspec: add-server-skeleton)`

## 8. Archive (after approval and commit)

- [x] 8.1 Merge `add-server-skeleton/specs/server/spec.md` ADDED block into a new `openspec/specs/server/spec.md` (create with Purpose + Requirements sections)
- [x] 8.2 Merge `add-server-skeleton/specs/health/spec.md` ADDED block into a new `openspec/specs/health/spec.md`
- [x] 8.3 Move `openspec/changes/add-server-skeleton/` → `openspec/changes/archive/2026-05-05-add-server-skeleton/`
- [x] 8.4 Commit: `chore(openspec): archive add-server-skeleton`
- [x] 8.5 Stage 1 begins (new change folder: `openspec/changes/add-pi-event-mapper/`)
