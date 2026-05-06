# Tasks: Agents + Workflows + Memory + Real Pi Probe

## 1. Types and writer foundation

- [ ] 1.1 Extend `src/types/kb.ts` with `KbNodeKind = 'skill' | 'agent' | 'workflow'`, widen `SkillNode.source`, extend `SkillEdge.kind` with `'composes' | 'step'`.
- [ ] 1.2 Create `src/server/kb-writer.ts` — generalized `writeKbFile({kind, name, body, frontmatter})` lifted from `skills-writer.ts`. Mkdir-as-reservation, tmp+rename, frontmatter strictness.
- [ ] 1.3 Refactor `src/server/skills-writer.ts` to delegate to `writeKbFile` while keeping its public API untouched.

## 2. Agents domain

- [ ] 2.1 `src/server/agent-writer.ts` — wraps `writeKbFile` for agents; validates `skills` array references against existing skill nodes (via `buildGraph` skills filter).
- [ ] 2.2 `src/routes/agents.ts` — `GET /api/agents`, `POST /api/agents`, `GET /api/agents/:name`.
- [ ] 2.3 Register in `src/server.ts` route table.
- [ ] 2.4 `tests/agent-writer.test.mjs` — atomic write, dangling skill ref rejection, name regex, frontmatter rendering.
- [ ] 2.5 `tests/agent-route.test.mjs` — 201 happy, 400 bad name, 400 dangling skills, 409 already exists, 404 unknown agent on read.

## 3. Workflows domain

- [ ] 3.1 `src/server/workflow-writer.ts` — wraps `writeKbFile` for workflows; validates each `steps[].ref` against the right entity kind (skill or workflow). Renders steps as `"<kind>:<ref>"` string array.
- [ ] 3.2 `src/routes/workflows.ts` — `GET /api/workflows`, `POST /api/workflows`, `GET /api/workflows/:name`.
- [ ] 3.3 Register in `src/server.ts`.
- [ ] 3.4 `tests/workflow-writer.test.mjs` — atomic write, dangling step rejection, name regex, step encoding.
- [ ] 3.5 `tests/workflow-route.test.mjs` — full suite.

## 4. Memory domain

- [ ] 4.1 `src/server/memory-writer.ts` — `readMemory(name)`, `writeMemory(name, content)` (upsert, atomic), `listMemory()`. No frontmatter machinery. 64 KB cap.
- [ ] 4.2 `src/routes/memory.ts` — `GET /api/memory`, `GET /api/memory/:name`, `PUT /api/memory/:name`.
- [ ] 4.3 Register in `src/server.ts`.
- [ ] 4.4 `tests/memory-writer.test.mjs` + `tests/memory-route.test.mjs` — full suite.

## 5. KB browser + watcher updates

- [ ] 5.1 Generalize `src/server/kb-browser.ts` `buildGraph` to walk skills/agents/workflows under `<kbRoot>/{skills,agents,workflows}`. Three node kinds, four edge kinds. Memory deliberately ignored.
- [ ] 5.2 Update `src/server/kb-watcher.ts` to root at `kbRoot` instead of `skillsDir`. Skill name extraction from path becomes a `<subdir>/<name>` extractor.
- [ ] 5.3 `src/server/wiring.ts` — add `kbRoot`, derived `agentsDir`, `workflowsDir`, `memoryDir`. `skillsDir` becomes `<kbRoot>/skills`. Honor both `PI_WORKSPACE_KB_ROOT` (preferred) and `PI_WORKSPACE_SKILLS_DIR` (legacy: derive `kbRoot` from it).
- [ ] 5.4 Extend `tests/kb-browser.test.mjs` — agent walk, workflow walk, dangling refs as diagnostics.
- [ ] 5.5 Extend `tests/kb-watcher.test.mjs` — agent file write produces a `kb.changed` event under `agents/`.
- [ ] 5.6 Extend `tests/kb-route.test.mjs` — graph endpoint returns mixed sources; channel isolation regression unaffected.

## 6. Real pi probe

- [ ] 6.1 Add `spawnPi: (args, opts) => ChildProcess` to `Wiring`, default `(args, opts) => spawn('pi', args, opts)`.
- [ ] 6.2 Rewrite the `pi` block of `src/routes/probe.ts` to spawn `pi --version` with `AbortSignal.timeout(3000)`, parse stdout, return `{ok, version, latencyMs, error?}`.
- [ ] 6.3 Add `agents.count`, `workflows.count`, `memory.count` to the probe response. Add `kbRoot` next to existing `skillsDir`.
- [ ] 6.4 `tests/probe.test.mjs` — fake spawnPi for deterministic pi-ok / pi-missing / pi-timeout / pi-unparseable cases.
- [ ] 6.5 `tests/integration/probe-live.smoke.mjs` (env-gated) — runs the real spawn when `pi` is on PATH; skips otherwise.

## 7. Providers domain

- [ ] 7.0a `src/server/providers-client.ts` — `listProviders()` returns the eight pi-supported providers (`github-copilot`, `anthropic`, `openai`, `openrouter`, `google`, `x-ai`, `deepseek`, `ollama`) with `{id, name, kind, status, statusReason?, models[]}`. OAuth checks `~/.pi/agent/auth.json`; key checks env vars; local probes `http://localhost:11434/api/tags` with 1s timeout.
- [ ] 7.0b `getActiveModel()` reads `~/.pi/agent/settings.json` (`defaultProvider` + `defaultModelId`); returns `{providerId:null, modelId:null}` when missing.
- [ ] 7.0c `setActiveModel({providerId, modelId})` validates against `listProviders()` (status configured/detected; modelId in models[]) then atomically (tmp+rename) updates settings.json preserving other fields.
- [ ] 7.0d `src/routes/providers.ts` — `GET /api/providers`, `GET /api/providers/active`, `PUT /api/providers/active`. Register in `src/server.ts`.
- [ ] 7.0e Probe endpoint includes `pi.activeProvider` + `pi.activeModel` from `getActiveModel()`.
- [ ] 7.0f `tests/providers-client.test.mjs` — stub fs + fetch for local-ollama probe; assert each status path; assert ollama-detected on 200; ollama-unconfigured on connection refused.
- [ ] 7.0g `tests/providers-route.test.mjs` — list endpoint shape; get-active null vs set; set-active happy + 400 PROVIDER_UNCONFIGURED + 400 UNKNOWN_MODEL + persistence.

## 8. Review + verification

## 8. Edit endpoints (live edit of skills/agents/workflows)

- [ ] 8.1 `PUT /api/skills/:name` — handler in `src/routes/skills.ts`, merge semantics (omitted fields preserved, `name` locked), atomic in-place tmp+rename. Tests: 200 happy, 404 missing, 400 oversized body, 400 invalid frontmatter, name-lock regression.
- [ ] 8.2 `PUT /api/agents/:name` — handler in `src/routes/agents.ts`, re-validates `skills[]` refs when provided, name locked.
- [ ] 8.3 `PUT /api/workflows/:name` — handler in `src/routes/workflows.ts`, re-validates `steps[]` refs when provided, name locked.

## 9. Multi-model chat + tool approval (chat-controls)

- [ ] 9.1 Bridge: add `bridge.setModel({providerId, modelId})` and `bridge.cycleModel(direction)` writing pi RPC commands.
- [ ] 9.2 Bridge: extend the stdout handler to recognize `extension_ui_request` lines and persist+emit them as `pi.ui-request` events via the existing run-store path. Track the live set of pending UI request ids per active run.
- [ ] 9.3 Stage-1 mapper: add `extension_ui_request` to the switch — produces `{event:"pi.ui-request", data:{runId, request}}`. Add fixture pair + snapshot test.
- [ ] 9.4 `src/routes/chat-controls.ts` — `POST /api/sessions/:sessionKey/model`, `POST /api/sessions/:sessionKey/model/cycle`, `POST /api/runs/:runId/ui-response`. Register in `src/server.ts`.
- [ ] 9.5 ui-response handler validates the request id is in flight; rejects 400 UNKNOWN_UI_REQUEST otherwise; rejects 409 RUN_FINISHED if the run already terminated.
- [ ] 9.6 Tests: model switch happy + invalid-provider rejection + persistence; cycle-model happy; ui-response forwarding + unknown-id 400 + RUN_FINISHED 409 + extension_ui_request fixture.

## 10. Review + verification

- [ ] 10.1 Every requirement scenario across all seven delta specs backed by at least one test.
- [ ] 10.2 Full local suite green (target: ~55 new tests).
- [ ] 10.3 Codex review iterated to clean.
- [ ] 10.4 Markdown + PDF review bundle saved to `review/`.
- [ ] 10.5 Three commits + push (propose / implement / archive).
