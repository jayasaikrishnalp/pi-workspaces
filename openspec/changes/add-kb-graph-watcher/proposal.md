# Proposal: KB Graph + Watcher

## Why

The defining feature of this workspace is "knowledge that compounds" — every Confluence lookup the agent does should be saveable as a permanent skill, so the next on-call SRE never has to look the same thing up twice. The visible payoff is the knowledge graph: an Obsidian-style D3 force layout that gains a new node every time a skill is saved. Without that visual, the loop of "save as skill → graph grows" is invisible.

Stage 4 ships the data side of the loop:
- Read every `.pi/skills/<name>/SKILL.md` under the workspace cwd, parse YAML frontmatter, build a node/edge graph (edges from explicit `uses:` field plus `[[wikilinks]]` in the body).
- Watch the directory with chokidar so a new SKILL.md drop produces a `kb.changed` event within ~200ms.
- Expose two endpoints:
  - `GET /api/kb/graph` — returns `{nodes, edges, diagnostics}` for a one-shot fetch.
  - `GET /api/kb/events` — separate SSE channel from chat, streaming filesystem changes for the live graph view.
- Provide 5 seed SKILL.md files in `seed-skills/` so the demo opens with non-empty state.

Two channels (chat + KB) are intentional: their lifecycles differ. A Tailscale-disconnected client that resubscribes shouldn't replay every chat event just to learn that a file changed; conversely, a chat replay shouldn't include filesystem noise.

## What changes

- New `kb` capability: skill discovery, graph build, diagnostics, file watcher, and the two HTTP endpoints.
- New `kb-event-bus` separate from the chat-event-bus.
- New `kb-watcher` using chokidar with `awaitWriteFinish` so partial-write races (atomic tmp + rename) are handled correctly.
- New `kb-browser` that walks `.pi/skills/`, parses frontmatter (using a tiny inline parser; pi's TypeBox skill schema is not imported because the workspace must tolerate skills that pi might reject — diagnostics surface what's broken without erroring the whole graph).
- Diagnostic entries: malformed YAML, missing `name` field, `uses:` reference to a nonexistent skill, body wikilink to a nonexistent skill. Each diagnostic has `path`, `severity`, `message`.
- Edges: `uses:` produces directed edges with `kind:"uses"`. `[[wikilink]]` in body produces `kind:"link"`. Duplicates collapse.
- Tests: graph build for the 5 seeds, watcher event delivery, dangling wikilink diagnostic, malformed YAML diagnostic, deleted skill removes node, atomic tmp+rename produces exactly one event (not two).

## Scope

**In scope**
- `.pi/skills/<name>/SKILL.md` discovery (one skill per directory; primary file is `SKILL.md`).
- Frontmatter fields read: `name` (required), `description`, `tags?`, `uses?`.
- Wikilinks: `[[skill-name]]` parsed from body.
- Diagnostics list returned alongside graph data.
- chokidar watch of `.pi/skills/**` with `awaitWriteFinish` and `ignoreInitial: false`.
- Two new endpoints, the second is SSE.

**Out of scope**
- Editing skills via API (Stage 6: `add-skill-creation-flow`).
- Reading skill content body via API beyond the graph endpoint (Stage 6 will add `/api/kb/skill/:name`).
- Cross-cwd skill listing (we only walk the workspace's own `.pi/skills`).
- Frontend rendering — the graph data is JSON for now (Stage 9 ships D3).
- Content-based clustering, search, recommendations.

## Impact

- Affected specs: `kb` (new domain).
- Affected code: `src/server/{kb-event-bus,kb-watcher,kb-browser}.ts`, `src/routes/kb.ts`, `src/server.ts` route table, `seed-skills/` (5 sample SKILL.md files), tests under `tests/kb-*.test.mjs` and `tests/integration/kb-watcher.smoke.mjs`.
- Risk level: low. No pi process touch, no external API; the only real moving part is the chokidar watcher and its `awaitWriteFinish` debouncing.
