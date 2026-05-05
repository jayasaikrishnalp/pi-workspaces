# Proposal: Skill Creation Flow

## Why

The demo loop is "search Confluence → save as skill → next time, KB hit." Stage 4 gave us the watcher that animates a new node when a SKILL.md appears. Stage 5 gave us the Confluence search/page client. Stage 6 closes the loop by letting the workspace WRITE a SKILL.md atomically — so a UI button or a future agent tool can convert "what we just learned" into a permanent skill on disk that the watcher will pick up within ~200ms.

The locked spec §Stage 6 calls out two paths to write a skill:

- **(a) From chat (agent tool)** — the agent calls a `create_skill(name, content)` tool that lives in a pi extension. The extension spawns a subagent (per spike4) to generate the SKILL.md body from prior context, then writes it.
- **(b) From server (HTTP)** — `POST /api/skills {name, content}` validates, writes, returns.

This change ships **path (b) only**. Path (a) requires loading a TypeScript extension into the running pi child, which is a separate piece of infrastructure (`~/.pi/agent/extensions/agent-builder.ts`, `pi.registerTool` lifecycle, integration tests against a live pi) that doesn't fit cleanly into the rest of Stage 6's contract. The frontend "Save as skill" button (Stage 8) calls path (b); the agent extension is preserved as a Phase 3 follow-up that builds on the same atomic-write helper this stage ships.

This is a deliberate, documented scope cut — it lands the demo loop's user-visible behavior tonight without forcing a pi-extension build that needs a manual auth step.

## What changes

- New `skills` capability:
  - `POST /api/skills` — body `{name, content?, frontmatter?}`. Validates `name` against `/^[a-z][a-z0-9-]{0,63}$/`. Writes `<skillsDir>/<name>/SKILL.md` atomically (tmp + rename). Returns 201 with the relative path.
  - `GET /api/kb/skill/:name` — returns the parsed skill: `{name, frontmatter, body, path}`. Validates name. 404 on missing.
- New `src/server/skills-writer.ts` exposing `writeSkill(skillsDir, input)` — atomic write helper used by the route now and by the future pi extension later.
- Frontmatter generation: the route accepts a structured `frontmatter` object (object with string/string[] fields) and renders it to YAML using the same shape Stage 4's parser accepts. The author keeps full control over the body via `content`.
- A new test that asserts the **full demo loop** end-to-end with the watcher:
  1. Initial graph has N skills.
  2. POST /api/skills creates a new skill.
  3. The chokidar watcher emits `kb.changed` for the new file within 1.5s.
  4. GET /api/kb/graph returns N+1 skills.
  5. The skill body matches what was POSTed.

## Scope

**In scope**
- `POST /api/skills` and `GET /api/kb/skill/:name` routes.
- `skills-writer.ts` atomic-write helper.
- Strict name validation, idempotent reject on existing skill (409), bounded body length (≤ 32 KB).
- Tests covering name validation, atomic write semantics (`SKILL.md.tmp` does NOT linger), kb.changed propagation, GET roundtrip.

**Out of scope**
- The pi extension that registers `create_skill` as an agent-callable tool. Phase 3 follow-up.
- Editing or deleting skills via API.
- Cross-cwd writes — only the workspace's own `.pi/skills/`.
- Front-end UI; Stage 8 wires a button to this route.

## Impact

- Affected specs: `skills` (new domain). Stage 4's `kb` requirements remain unchanged but the existing `kb.changed` event becomes the primary observable signal.
- Affected code: `src/server/skills-writer.ts`, `src/routes/skills.ts`, `src/server.ts` (routes), `src/routes/kb.ts` (extends with `GET /api/kb/skill/:name`), tests.
- Risk level: low. The write path is one helper guarded by validation; the watcher integration is already proven in Stage 4.
