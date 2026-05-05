# Design: KB Graph + Watcher

## Approach

Three pure modules + one route file:

```
.pi/skills/<name>/SKILL.md      ──parse──►  SkillFile { path, frontmatter, body }
                                                  │
                                                  ▼
                                          kb-browser.buildGraph()  ─►  { nodes, edges, diagnostics }
                                                                            │
                                                  ┌─────────────────────────┘
                                                  ▼
                                  GET /api/kb/graph  (one-shot JSON)


.pi/skills/**/*  ──chokidar──► onChange  ──►  kbBus.emit({kind, path, skill, ts})
                                                              │
                                                  ┌───────────┘
                                                  ▼
                                  GET /api/kb/events  (SSE)
```

The graph build is stateless — every GET re-walks the directory. For ≤500 skills that takes <50ms. We do not cache: the watcher is the cache invalidation mechanism, and the graph is small enough that recomputing is simpler than maintaining incremental updates.

## Architecture

### `kb-browser`

Public surface:
```ts
interface SkillNode {
  id: string         // == frontmatter.name
  name: string
  description?: string
  tags?: string[]
  path: string       // path on disk relative to skillsDir
  source: 'skill'    // future stages may add 'workflow', 'memory'
}
interface SkillEdge {
  source: string     // node id
  target: string     // node id
  kind: 'uses' | 'link'
}
interface Diagnostic {
  path: string
  severity: 'error' | 'warn'
  message: string
}
interface KbGraph {
  nodes: SkillNode[]
  edges: SkillEdge[]
  diagnostics: Diagnostic[]
}

buildGraph(skillsDir: string): Promise<KbGraph>
parseSkillFile(absPath: string): SkillFile | DiagnosticOnly
```

Frontmatter parsing: a tiny home-grown parser that reads everything between leading `---\n` and `\n---\n`. We do NOT import a YAML library — the locked spec only allows the four scalar/array fields above, and a strict line-based reader (`key: value` and `key:\n  - item\n  - item`) keeps the dependency surface zero. Anything richer falls through to a diagnostic.

### `kb-event-bus`

A second `EventBus` instance, distinct from `chat-event-bus`. Same shape (subscribe / unsubscribe / emit) but emits `KbEvent`:
```ts
interface KbEvent {
  kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string       // absolute
  skill: string | null  // skill name extracted from path if applicable
  ts: number
}
```

Singleton on `globalThis.__kbEventBus`.

### `kb-watcher`

Wraps chokidar. Configured with:
- `awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }` so atomic tmp+rename produces ONE add event, not the multi-event burst chokidar would otherwise emit.
- `ignoreInitial: false` — startup walks emit `add` events for existing files. The initial-add events ARE published on the bus, but they're a one-time burst on subscribe; a client that wants only-new-changes can record `Date.now()` at subscribe and filter `event.ts < startTs`.
- `depth: 5` — `.pi/skills/<name>/SKILL.md` is depth 2; we cap at 5 to allow modest nesting without runaway traversal.

The watcher exposes:
```ts
class KbWatcher {
  start(skillsDir: string): Promise<void>
  stop(): Promise<void>
}
```

`start()` returns a promise that resolves once chokidar emits `ready`, so callers can wait for the initial scan to finish before declaring the workspace booted.

### `routes/kb.ts`

Two handlers:
- `handleKbGraph(req, res, w)` — calls `buildGraph(w.skillsDir)`, returns 200 JSON.
- `handleKbEvents(req, res, w)` — opens an SSE stream subscribed to `kbBus`. Heartbeat every 30s. Closes on `req.on('close')`.

The wiring exposes a new `skillsDir` and `kbBus` field. The existing `bus` (chat) is unchanged.

## Decisions

- **Decision:** Recompute the graph on every GET; no cache.
  **Alternatives:** maintain an incremental graph keyed by path; refresh on watcher events.
  **Why:** ≤500 skills × ~1KB each = ~500KB to read. <50ms on warm fs. The bug surface of incremental graph maintenance (stale edges, leaks) is not worth the savings at this scale.

- **Decision:** Inline frontmatter parser, no YAML library.
  **Alternatives:** `js-yaml`, pi's TypeBox schema.
  **Why:** the four allowed field shapes (string, string[], object) cover everything; YAML's full surface (anchors, aliases, multiline, tagged types) is wasted complexity here. Skills that need richer YAML are out of scope; the diagnostic flags them.

- **Decision:** Two SSE channels, not one merged.
  **Why:** locked spec §2.1 mandates this. Different lifecycles, different consumers, easier filtering on both server and client.

- **Decision:** `awaitWriteFinish: { stabilityThreshold: 100 }` rather than a higher value.
  **Alternatives:** 200ms (more conservative); 50ms (tighter).
  **Why:** spike3 verified 100ms catches `tmp + rename` patterns reliably without making the live graph feel sluggish. Faster = more events; slower = perceived lag.

- **Decision:** chokidar `ignoreInitial: false`. Initial scan emits add events.
  **Alternatives:** `ignoreInitial: true` and only fire on changes.
  **Why:** a client that subscribes after server start needs to know what's already there if they didn't load the graph first. The cost is a small burst of events on subscribe; clients filter by ts if they care.

- **Decision:** `[[wikilink]]` parsing is a regex over the body, after frontmatter is stripped.
  **Alternatives:** full markdown AST.
  **Why:** wikilink regex `/\[\[([a-zA-Z0-9_-]+)\]\]/g` is unambiguous given our skill naming policy (kebab-case, alphanumeric + dashes/underscores). A markdown parser is overkill for one feature.

- **Decision:** Diagnostics are surfaced alongside graph data, not thrown.
  **Why:** a single broken SKILL.md should not 500 the graph endpoint or hide the rest of the user's skills. Each problem is a discrete diagnostic the UI can show as a banner.

## Affected files & packages

New:
- `src/server/kb-event-bus.ts`
- `src/server/kb-browser.ts`
- `src/server/kb-watcher.ts`
- `src/types/kb.ts`
- `src/routes/kb.ts`
- `seed-skills/{check-server-health,reboot-server,patch-vm,disk-cleanup,wk-patch-class-tags}/SKILL.md`
- `tests/kb-browser.test.mjs`
- `tests/kb-watcher.test.mjs` (uses real chokidar with a tempdir)
- `tests/kb-route.test.mjs`

Modified:
- `src/server/wiring.ts` — add `skillsDir`, `kbBus`, instantiate the watcher.
- `src/server.ts` — register routes.
- `package.json` — add `chokidar@^4`.

## Risks & mitigations

- **Risk:** chokidar inotify limits on Linux for huge skills directories.
  **Mitigation:** depth cap of 5; a healthy CloudOps SRE has dozens to low hundreds of skills, well under any limit.
- **Risk:** atomic tmp + rename produces multiple events.
  **Mitigation:** `awaitWriteFinish`. Tested with a fixture that writes `tmp` and renames atomically.
- **Risk:** Frontmatter parser misreads a multiline value.
  **Mitigation:** explicit diagnostic when a value spans multiple lines without a `- ` array prefix; surface the path so the user can fix.
- **Risk:** Wikilink regex matches code spans (e.g., `[[ literal in JSON ]]`).
  **Mitigation:** strip fenced code blocks before scanning. Test asserts.
- **Risk:** Watcher's initial-add burst overwhelms a late SSE subscriber.
  **Mitigation:** the initial burst is bounded by the file count; clients receive at-most-once delivery (no replay), so on subscribe they get nothing for already-loaded files. We document this: clients should `GET /api/kb/graph` first, then subscribe to `/api/kb/events`.
