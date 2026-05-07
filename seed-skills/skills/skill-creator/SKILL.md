---
name: skill-creator
description: "Create new skills (and update existing ones) inside the Hive workspace via the /api/skills HTTP API. Use whenever the user asks to 'add a skill', 'teach you how to do X', 'save this as a skill', 'create a skill for …', or whenever you discover a repeatable workflow during a chat that's worth bottling up for next time. Also covers updating an existing skill via PUT."
---

# Skill Creator (Hive Workspace)

This is the Hive equivalent of Claude's `skill-creator`. The mechanics are
different — Hive skills live as plain `SKILL.md` files served by the
workspace backend, with a kb-watcher that picks up changes live — so the
loop is much shorter than Anthropic's full eval/benchmark/package flow.

If you want the long-form iterative eval workflow (test prompts,
quantitative benchmarks, blind A/B), use Anthropic's
`~/.claude/skills/skill-creator/` separately. This skill is for the 90%
case: "I want to teach pi how to do X — wrap it as a skill."

## When to trigger

- "Save this as a skill" / "make a skill out of this"
- "Add a skill for …"
- "Teach you how to ..." (mid-chat workflow worth capturing)
- "Update the X skill" / "fix the Y skill"
- You notice in the current session that you've explained the same recipe
  twice — bottle it.

## Where Hive skills live

| Layer | Path | Notes |
|---|---|---|
| Repo source-of-truth | `<repo>/seed-skills/skills/<name>/SKILL.md` | Committed, ships with the workspace |
| Runtime (per host) | `~/.pi/agent/skills/<name>/SKILL.md` | Synced from the repo on `start.sh` boot |
| Live edits (per host) | `<PI_WORKSPACE_KB_ROOT>/skills/<name>/SKILL.md` | Defaults to `<repo>/seed-skills/skills/`. Watched by kb-watcher; new files appear in the catalog within ~1 sec. |

You don't write files yourself — call the HTTP API. The API enforces the
naming rules + frontmatter shape and writes atomically.

## API contract

**Create**
```
POST /api/skills
body: { "name": "<kebab-case>", "content": "<markdown body>", "frontmatter": { "description": "..." } }
→ 201 { name, path }
errors: 400 INVALID_SKILL_NAME · 409 SKILL_EXISTS · 400 BODY_TOO_LARGE (>32 KB)
```

**Update**
```
PUT /api/skills/:name
body: { "content": "<full new body>", "frontmatter"?: {...} }
→ 200 { name, path }
errors: 404 UNKNOWN_SKILL · 400 BODY_TOO_LARGE
```

**Read existing skill before editing**
```
GET /api/kb/skill/:name
→ 200 { name, frontmatter, body }
```

Auth: from inside pi (Hive workspace), use the env var
`WORKSPACE_INTERNAL_TOKEN` as the `x-workspace-internal-token` header.
Without it you'll get 401.

## Naming rules (validated server-side)

- `name`: `^[a-z][a-z0-9-]{0,63}$` — kebab-case, must start with a letter
- Body: <= 32 KB
- Frontmatter `name` field, if present, must match the URL `name`. If
  omitted, the API stamps it for you.

## How to call from pi (bash skill harness)

```bash
TOKEN="${WORKSPACE_INTERNAL_TOKEN:?missing}"
NAME="$1"
DESC="$2"
BODY_FILE="$3"
PORT="$(cat ~/.pi-workspace/server.port 2>/dev/null || echo 8766)"

PAYLOAD=$(jq -n \
  --arg name "$NAME" \
  --arg content "$(cat "$BODY_FILE")" \
  --arg desc "$DESC" \
  '{name: $name, content: $content, frontmatter: {description: $desc}}')

curl -sS -X POST \
  -H "Content-Type: application/json" \
  -H "x-workspace-internal-token: $TOKEN" \
  -d "$PAYLOAD" \
  "http://127.0.0.1:${PORT}/api/skills"
```

For an UPDATE, swap to `-X PUT` and append `/<name>` to the URL.

## SKILL.md anatomy (what to put in `content`)

```markdown
---
name: <same as URL name>
description: "<one-line trigger sentence — see writing tips below>"
---

# <Title>

<one-paragraph what & why>

## When to use

- "<exact phrase user might say>"
- "<another trigger phrase>"
- "<context where this skill applies>"

## How to do it

<steps. Use bash blocks if there's a recipe. Be explicit about env vars,
file paths, command flags.>

## Anti-patterns

- Don't <thing 1>
- Don't <thing 2>
```

## Writing the description (the part that matters most)

The frontmatter `description` is the trigger signal. Pi only loads a
skill into context when the user's message + active context match the
description well. Short, vague descriptions miss-fire; over-long ones
dilute. Aim for 1–2 sentences that contain:

1. **What the skill does** (verb-first: "Query Jira via …", "Build AMI from …")
2. **At least 2-3 trigger phrases** in the user's likely vocabulary
   ("when the user asks about a Jira ticket / says 'find me the highest-priority' / mentions GHCOS-N")

Pi tends to **under-trigger** skills — when in doubt, write the
description a touch pushy: "Use whenever the user mentions X, Y, or Z,
even if they don't ask for the skill by name."

**Bad**: `"Create skills."`
**Good**: `"Create new skills inside the Hive workspace via /api/skills.
Use whenever the user says 'save this as a skill', 'add a skill for X',
or you notice a repeatable workflow worth capturing."`

## Workflow

1. **Clarify intent** — confirm the skill name, what it should trigger
   on, and what the body should contain. If the conversation already
   has the context (e.g. user said "save what we just did as a skill"),
   extract it from the recent messages instead of asking 5 questions.
2. **Draft the SKILL.md body** in a temp file. Keep it under ~250 lines
   for the body — pi reads the whole thing each time the skill triggers.
3. **POST /api/skills** — see recipe above. The kb-watcher will register
   the new skill within ~1 sec.
4. **Tell the user where it landed**: filesystem path + screen
   ("Skills sidebar at http://3.81.200.3:5173/skills"). Include the API
   response payload (`name`, `path`).
5. **Sanity-check**: ask the user to phrase a request that should
   trigger it — see if the new skill loads on the next message.

## Updating an existing skill

```bash
# 1. Fetch the current body to avoid clobbering content the user wrote.
curl -sS -H "x-workspace-internal-token: $TOKEN" \
  "http://127.0.0.1:${PORT}/api/kb/skill/${NAME}" | jq -r '.body' > /tmp/current.md

# 2. Edit /tmp/current.md (apply the user's requested change).

# 3. PUT the full new body back.
curl -sS -X PUT \
  -H "Content-Type: application/json" \
  -H "x-workspace-internal-token: $TOKEN" \
  -d "$(jq -n --arg c "$(cat /tmp/current.md)" '{content:$c}')" \
  "http://127.0.0.1:${PORT}/api/skills/${NAME}"
```

The PUT semantics replace the whole body. If you only want to tweak the
description, fetch first, modify the frontmatter, write back the same
body.

## Anti-patterns

- **Don't write the file directly with `fs.write` or `cat > ...`.** The
  kb-watcher won't validate the frontmatter and you'll silently break
  the catalog. Always go through the API.
- **Don't set `name` in the frontmatter to something different from the
  URL name.** The server rejects this.
- **Don't paste credentials, tokens, or full file contents from
  `~/.aws/credentials`-shaped sources** into a SKILL.md. They get indexed
  by the wiki search and surface back to other agents.
- **Don't make a skill for a one-off task.** Skills are for things you'd
  do again. If it's a single-shot, just do it.
- **Don't write 800-line SKILL.md files.** Split into a top-level
  workflow and a `references/` sibling for deep dives. (For most Hive
  skills, a single 100-200 line SKILL.md is the right size.)
- **Don't try to package a `.skill` file** — Hive doesn't use that
  format. The single SKILL.md file IS the skill.

## Verifying the skill is live

```bash
# Confirm it appears in the catalog
curl -sS -H "x-workspace-internal-token: $TOKEN" \
  "http://127.0.0.1:${PORT}/api/kb/graph" | jq '.nodes[] | select(.id=="<NAME>")'

# Or hit the GET endpoint
curl -sS -H "x-workspace-internal-token: $TOKEN" \
  "http://127.0.0.1:${PORT}/api/kb/skill/<NAME>" | jq '.frontmatter'
```

If you don't see the skill within ~2 sec, the kb-watcher is disabled
(`PI_WORKSPACE_DISABLE_WATCHER=1`) — restart the workspace to pick it up.
