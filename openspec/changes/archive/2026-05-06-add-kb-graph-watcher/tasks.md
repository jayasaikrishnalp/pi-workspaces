# Tasks: KB Graph + Watcher

## 1. Types and bus

- [ ] 1.1 `src/types/kb.ts` — `SkillNode`, `SkillEdge`, `Diagnostic`, `KbGraph`, `KbEvent`, `KbEventKind`.
- [ ] 1.2 `src/server/kb-event-bus.ts` — singleton bus, subscribe/emit pattern (mirror chat bus shape).

## 2. Skill discovery + graph build

- [ ] 2.1 `src/server/kb-browser.ts` — `parseSkillFile(path)`, `buildGraph(skillsDir)`. Inline frontmatter parser. Wikilink scan.
- [ ] 2.2 Diagnostics: malformed YAML, missing `name`, dangling `uses`, dangling wikilink. Each carries `path`, `severity`, `message`.

## 3. Watcher

- [ ] 3.1 `src/server/kb-watcher.ts` — chokidar with `awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }`, `depth: 5`, `ignoreInitial: false`. Forwards events to kb-bus.
- [ ] 3.2 `start(skillsDir)` resolves on `ready`. `stop()` closes chokidar.

## 4. Routes

- [ ] 4.1 `src/routes/kb.ts` — `GET /api/kb/graph` (one-shot JSON), `GET /api/kb/events` (SSE).
- [ ] 4.2 Wire in `src/server/wiring.ts`: `kbBus`, `skillsDir`, `watcher`. Register routes in `src/server.ts`.

## 5. Seed skills

- [ ] 5.1 Five `seed-skills/<name>/SKILL.md` files: `check-server-health`, `reboot-server`, `patch-vm`, `disk-cleanup`, `aws-cleanup` (with `uses: [check-server-health]` to demonstrate edges).

## 6. Tests

- [ ] 6.1 `tests/kb-browser.test.mjs` — parse seeds; malformed yaml → diagnostic; missing name → diagnostic; dangling uses → diagnostic; dangling wikilink → diagnostic; uses + wikilink → both edge kinds.
- [ ] 6.2 `tests/kb-watcher.test.mjs` — temp dir, atomic write produces one event, unlink, addDir; awaitWriteFinish prevents burst.
- [ ] 6.3 `tests/kb-route.test.mjs` — graph endpoint, events endpoint with SSE handshake, channel isolation (chat subscriber doesn't see kb event), missing/unknown sessionKey behavior in chat unchanged.

## 7. Review + verification

- [ ] 7.1 Every requirement scenario backed by a test.
- [ ] 7.2 Full local suite green.
- [ ] 7.3 Codex review iterated to clean.
- [ ] 7.4 Markdown + PDF review bundle.
- [ ] 7.5 Three commits + push.
