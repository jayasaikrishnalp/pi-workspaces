# Design: Agents + Workflows + Memory + Real Pi Probe

## Approach

Three new write/read endpoints share one concern: take JSON, validate, render YAML frontmatter + markdown body, write atomically, expose via list + read endpoints. Stage 6's `writeSkill` already does this for skills; we factor a generic `writeKbFile` and three thin specializations on top.

The kb domain's `buildGraph` becomes the single source of truth for what's on disk under `.pi/`. It walks four kinds and unifies them under one `nodes/edges/diagnostics` shape, distinguished by the `source` field on each node.

The pi probe is a one-page rewrite: replace the auth.json existence check with a real spawn.

## Architecture

### `src/server/kb-writer.ts` (new)

Generalized atomic writer that powers skills, agents, and workflows. Stage 6's `writeSkill` becomes a thin wrapper:

```ts
interface WriteKbFileInput {
  /** Subdir under .pi/ (e.g. "skills", "agents", "workflows"). */
  kind: 'skills' | 'agents' | 'workflows'
  name: string
  body?: string
  /** Validated structured frontmatter. Caller's `name` always wins. */
  frontmatter?: Record<string, unknown>
}

writeKbFile(kbRoot: string, input: WriteKbFileInput): Promise<{relPath: string; absPath: string}>
```

Same name regex (`/^[a-z][a-z0-9-]{0,63}$/`), same body cap (32_768 chars), same mkdir-as-reservation concurrency guard, same `INVALID_FRONTMATTER` errors. Each kind gets its own write target: `<kbRoot>/<kind>/<name>/<KIND>.md` (e.g. `<kbRoot>/agents/my-agent/AGENT.md`).

### `src/server/kb-browser.ts` (extended)

```ts
interface KbGraph {
  nodes: SkillNode[]              // distinguished by `source: 'skill'|'agent'|'workflow'`
  edges: SkillEdge[]              // existing 'uses'|'link', plus new 'composes'|'step'
  diagnostics: Diagnostic[]
}
buildGraph(kbRoot: string): Promise<KbGraph>
```

The walker:
1. `<kbRoot>/skills/*/SKILL.md` → existing logic, `source:'skill'`. uses/link edges as today.
2. `<kbRoot>/agents/*/AGENT.md` → parse frontmatter, require `skills` array, emit `source:'agent'` node + `composes` edge per skill (target = skill node). Dangling skill ref → diagnostic, no edge.
3. `<kbRoot>/workflows/*/WORKFLOW.md` → require `steps` array of `{kind, ref}`. Emit `source:'workflow'` node + `step` edge per step (kind:`skill` → skill node, kind:`workflow` → other workflow node). Dangling refs → diagnostic.
4. Anything else under `<kbRoot>/` (including `<kbRoot>/memory/*`) is ignored quietly. Memory files are intentionally not nodes — they're operator-owned text, not entities the graph reasons about.

### `src/routes/{agents,workflows,memory}.ts` (new)

Three thin handlers per kind. Memory has no frontmatter machinery, just direct read/write of the body.

| Method+path | Handler |
|---|---|
| `GET /api/agents` | list `<kbRoot>/agents/*/AGENT.md`, return `{agents:[{name, description, skills[]}]}` |
| `POST /api/agents` | `writeKbFile({kind:'agents', ...})` after validating each `skills[]` ref against `buildGraph` skills |
| `GET /api/agents/:name` | read + parse, return `{name, frontmatter, body, path}` |
| `GET /api/workflows` | list |
| `POST /api/workflows` | write after validating each `steps[].ref` |
| `GET /api/workflows/:name` | read + parse |
| `GET /api/memory` | list `<kbRoot>/memory/*.md` with `{name, size, mtime}` |
| `GET /api/memory/:name` | read body (no frontmatter parsing) |
| `PUT /api/memory/:name` | write atomically; **upsert** (creates or replaces) |

Memory is the one place we intentionally allow upsert via PUT. Skills/agents/workflows reject re-creation (`409 SKILL_EXISTS` etc.) because they are entities; memory is just a notepad.

### `src/server/kb-watcher.ts` (extended)

Today's watcher roots at `<workspace>/.pi/skills/`. We widen it to `<workspace>/.pi/` so chokidar fires for agents, workflows, and memory too. The `KbEvent.skill` field becomes more general — keep the field name but document that it's "the entity name extracted from path", which works for any of the four subdirs. `KbEvent.kind` is the existing `add|change|unlink|addDir|unlinkDir` chokidar kind. Frontend listeners can read the `path` to know which subdir.

### `src/routes/probe.ts` (modified)

```ts
async function probePi(timeoutMs = 3_000): Promise<{ ok: boolean; version?: string; latencyMs?: number; error?: string }> {
  const t0 = Date.now()
  try {
    const child = spawn('pi', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(timeoutMs),
    })
    const out = await readStdout(child)              // resolves on close
    const m = /^(\d+\.\d+\.\d+)/.exec(out.trim())
    if (!m) return { ok: false, error: `unparseable output: ${out.slice(0, 100)}` }
    return { ok: true, version: m[1], latencyMs: Date.now() - t0 }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { ok: false, error: `pi --version timed out after ${timeoutMs}ms` }
    }
    return { ok: false, error: (err as Error).message }
  }
}
```

Inject `spawnPi` (signature `(args: string[], opts) => ChildProcess`) via wiring so tests don't shell out. Default to real `spawn`. The probe handler calls this and includes `version` + `latencyMs` in the response when `ok`. The auth.json existence check moves to a separate field (`auth.piAuthJsonPresent`) since it remains useful diagnostic info — just no longer claimed as "pi works".

### Wiring + state

`Wiring` adds:
- `kbRoot: string` — defaults to `<workspaceCwd>/.pi`. Existing `skillsDir` becomes a derived getter that returns `<kbRoot>/skills` for back-compat.
- `agentsDir`, `workflowsDir`, `memoryDir` — derived (`<kbRoot>/agents` etc.).
- `spawnPi: (args, opts) => ChildProcess` — defaults to `spawn('pi', args, opts)`. Tests override.

The existing `PI_WORKSPACE_SKILLS_DIR` env var still works; we add `PI_WORKSPACE_KB_ROOT` (preferred), and if both are set the explicit `PI_WORKSPACE_KB_ROOT` wins.

## Decisions

- **One generic writer, three specializations.** Stage 6 already wrote `skills-writer.ts`; agents and workflows would duplicate ~70% of it. A single `writeKbFile` + three callers is cleaner than three siblings drifting.
- **Memory is upsert (PUT), entities are create-only (POST).** Memory files are a notepad — overwriting is the intended UX. Skills/agents/workflows are first-class entities — overwriting them silently would hide a name collision bug.
- **Workflows store `{kind, ref}` step objects, not flat strings.** A step that says `"reboot-server"` could mean "the skill" or "the workflow named reboot-server" — disambiguate with `kind`. Future Phase 2 workflow engine will read this without ambiguity.
- **Agents validate skill refs at write time AND graph-build time.** Write-time keeps bad data off disk; graph-build catches drift if a referenced skill is later deleted.
- **Memory is NOT a graph node.** It would muddle the "this is the system's reasoning surface" story — operator notes don't get edges. Memory files are surfaced through `/api/memory` only.
- **`kbRoot` widening is back-compat.** The existing `skillsDir` getter is preserved; old route handlers untouched. New routes use `agentsDir`/`workflowsDir`/`memoryDir`.
- **Real pi probe is bounded at 3s.** A pi spawn that takes longer than 3s is broken anyway. The frontend dashboard polls every 30s — a 3s timeout never blocks the UI.
- **Probe doesn't actually invoke pi RPC.** `pi --version` is a fast read, no model load, no auth required. Doing a real RPC ping would be more thorough but eat ~3-10s on first call (pi spawns and loads the agent). Trading thoroughness for responsiveness here.

## Affected files

New:
- `src/server/kb-writer.ts`
- `src/server/agent-writer.ts`, `src/server/workflow-writer.ts` (thin wrappers + validation)
- `src/server/memory-writer.ts` (no frontmatter)
- `src/routes/agents.ts`, `src/routes/workflows.ts`, `src/routes/memory.ts`
- `tests/kb-writer.test.mjs`, `tests/agent-writer.test.mjs`, `tests/workflow-writer.test.mjs`, `tests/memory-route.test.mjs`, `tests/probe.test.mjs`
- `tests/integration/probe-live.smoke.mjs` (env-gated for the real spawn)

Modified:
- `src/types/kb.ts` — add `KbNodeKind`, extend `SkillNode.source`, extend `SkillEdge.kind`.
- `src/server/kb-browser.ts` — generalize the walker.
- `src/server/kb-watcher.ts` — root at `kbRoot`, not `skillsDir`.
- `src/server/wiring.ts` — `kbRoot` + derived dirs + `spawnPi`.
- `src/routes/kb.ts` — `GET /api/kb/skill/:name` becomes `GET /api/kb/skill/:name` still + new `GET /api/kb/agent/:name` and `GET /api/kb/workflow/:name` for graph node detail.
- `src/routes/probe.ts` — real probe.
- `src/server.ts` — register six new routes.
- `src/routes/skills.ts` — uses `writeKbFile` instead of `writeSkill` (skills-writer.ts becomes a re-export shim for back-compat).
- `tests/kb-browser.test.mjs` — extend with agent/workflow walks + dangling-ref diagnostics.

## Risks & mitigations

- **Risk:** A pre-existing user with `.pi/skills/` already populated trips on the wider watcher walking unrelated dirs.
  **Mitigation:** the walker only reads `<kbRoot>/{skills,agents,workflows}/`. Anything else stays an `unlinkDir`/`addDir` event in the bus but produces no graph node.
- **Risk:** A frontend that depended on the `skillsDir` field on `/api/probe` workspace info breaks.
  **Mitigation:** `/api/probe` returns BOTH `skillsDir` and `kbRoot` (alias). The frontend can migrate at its own pace.
- **Risk:** A workflow step refs a skill that gets deleted later. Subsequent `buildGraph` produces a dangling-step diagnostic AND drops the edge — but the workflow file remains. The frontend's workflows screen needs to render that diagnostic.
  **Mitigation:** the `Workflows` screen (Change 2) reads diagnostics and shows a per-workflow warning row. Backend never auto-deletes workflows on dangling refs.
- **Risk:** `pi --version` outputs differ across pi versions / patches.
  **Mitigation:** the regex `^(\d+\.\d+\.\d+)` is permissive (matches `0.73.0`, `0.73.1+abc`, etc.). If pi changes its version output entirely we'll see the unparseable-output error message and fix it.
