---
name: query-knowledge-base
description: "Query the Hive WK pipeline knowledge base via curl + jq."
---

# Query the Hive Knowledge Base

The Hive workspace runs a full-text search index over the WK pipeline wiki
(`~/pipeline-information/wiki` on the host). Use this skill any time the
user asks about pipelines, GHO-IAC repos, runbooks, AWS account procedures,
or anything that might already be documented internally — **search the KB
first** before answering from general knowledge.

## When to use

Trigger any of these and you should call the KB tool first:

- "How do I …" / "What is …" / "Where is …" about WK / GHCOS / GHO-IAC
- Anything mentioning a repo name, pipeline ID, or a Confluence runbook
- The user pastes an error and asks for the runbook
- You're about to write a substantial answer to a WK-domain question

If the KB returns nothing relevant, say so explicitly and proceed with
your best general answer.

## How to call it

The Hive backend exposes a localhost-only HTTP endpoint. Run inside pi's
bash tool:

```bash
QUERY="${QUERY:?set QUERY first}"
curl -sS -b "${HIVE_COOKIE_JAR:-/tmp/hive-cookie.txt}" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":${QUERY@Q},\"limit\":5}" \
  http://127.0.0.1:8766/api/tools/search-wiki | jq .
```

Response shape:

```json
{
  "query": "GHO-IAC backup runbook",
  "source": "pipeline-information/wiki",
  "results": [
    { "path": "category-iac/...", "title": "...", "snippet": "...", "score": 0.83 }
  ]
}
```

For a single full doc by path:

```bash
curl -sS -b "${HIVE_COOKIE_JAR}" \
  "http://127.0.0.1:8766/api/wiki/doc?path=$(jq -rn --arg p "$PATH_RELATIVE" '$p|@uri')" | jq .
```

## Auth

The endpoints require the Hive workspace_session cookie. The user has
already logged into the workspace, so a cookie jar is on disk at
`$HIVE_COOKIE_JAR` (defaults to `/tmp/hive-cookie.txt`). If you get
401 AUTH_REQUIRED, surface that — don't try to authenticate yourself.

## Trigger reingest after adding a doc

If you wrote a new markdown file under `~/pipeline-information/wiki/`,
the chokidar watcher picks it up automatically — no action needed. If
the watcher is disabled (rare), force a rescan:

```bash
curl -sS -b "${HIVE_COOKIE_JAR}" -X POST http://127.0.0.1:8766/api/wiki/reindex | jq .
```

## What the KB contains

- `category-*.md` — GHCOS repo categories (code-games, IAC, etc.)
- `repos/*.md` — per-repo readmes + pipeline summaries
- `pipelines/*.md` — Azure DevOps pipeline definitions
- `runbooks/*.md` — operations runbooks (when present)

The user maintains it via Claude Code following the Karpathy LLM Wiki
pattern. New raw sources go in `~/pipeline-information/raw/`; Claude
ingests them into `wiki/` and updates `wiki/index.md`.

## Anti-patterns

- Don't re-ingest manually unless the watcher is broken — it loops.
- Don't write secrets or tokens into wiki pages — they're indexed.
- Don't fabricate a citation. If a result's snippet doesn't actually
  answer the question, say so and pick another result or move on.
