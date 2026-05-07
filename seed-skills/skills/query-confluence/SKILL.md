---
name: query-confluence
description: "Query Confluence via REST API using CONFLUENCE_BASE_URL + ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN env vars."
---

# Query Confluence

The Hive Secret Store injects Confluence credentials at spawn time. Use
them to read pages, search, and post comments via curl — don't claim "no
Confluence access."

## Required env vars (auto-injected)

| Env var | What it is |
|---|---|
| `CONFLUENCE_BASE_URL` | Atlassian site (e.g. `https://wkengineering.atlassian.net`) |
| `ATLASSIAN_EMAIL` | Email of the API token owner |
| `ATLASSIAN_API_TOKEN` | Personal API token (same one as Jira on Atlassian Cloud) |

If any of these are unset, the Secret Store hasn't been populated — say so
and stop.

## Auth pattern

Confluence Cloud uses Basic auth with `email:api_token`:

```bash
AUTH="${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}"
BASE="${CONFLUENCE_BASE_URL%/}"
# Confluence Cloud REST root: <site>/wiki/rest/api (legacy) OR
# <site>/wiki/api/v2 (newer). The v2 API is preferred.
```

## Common operations

### Search by CQL (Confluence Query Language)

```bash
QUERY="${1:?usage: query='outage runbook'}"
curl -sS -u "$AUTH" -G \
  --data-urlencode "cql=text ~ \"${QUERY}\" AND type = page" \
  --data-urlencode 'limit=10' \
  "${BASE}/wiki/rest/api/content/search" |
  jq '.results[] | {id, title, url: ._links.webui}'
```

### Fetch a page by id with body

```bash
PAGE_ID="${1:?usage: PAGE_ID=123456}"
curl -sS -u "$AUTH" \
  "${BASE}/wiki/api/v2/pages/${PAGE_ID}?body-format=storage" |
  jq '{id, title, body: .body.storage.value}'
```

To get the rendered HTML or plain text:

```bash
curl -sS -u "$AUTH" \
  "${BASE}/wiki/rest/api/content/${PAGE_ID}?expand=body.view" |
  jq -r '.body.view.value' | sed 's/<[^>]*>//g' | sed '/^$/d'
```

### List child pages of a page

```bash
PARENT_ID="$1"
curl -sS -u "$AUTH" \
  "${BASE}/wiki/api/v2/pages/${PARENT_ID}/children" |
  jq '.results[] | {id, title}'
```

### Find a page by title in a specific space

```bash
SPACE_KEY="${1:?usage: SPACE_KEY=OPS}"
TITLE="${2:?usage: TITLE='RDS Failover Runbook'}"
curl -sS -u "$AUTH" -G \
  --data-urlencode "spaceKey=${SPACE_KEY}" \
  --data-urlencode "title=${TITLE}" \
  --data-urlencode 'expand=body.view' \
  "${BASE}/wiki/rest/api/content" |
  jq '.results[0] | {id, title, body: .body.view.value}'
```

### Add a comment to a page

```bash
PAGE_ID="$1"
COMMENT="$2"
curl -sS -u "$AUTH" \
  -X POST -H 'Content-Type: application/json' \
  -d "$(jq -Rn --arg pid "$PAGE_ID" --arg body "$COMMENT" \
    '{type:"comment", container:{type:"page", id:$pid}, body:{storage:{value:("<p>"+$body+"</p>"), representation:"storage"}}}')" \
  "${BASE}/wiki/rest/api/content"
```

## Errors

- `401` → token wrong / expired; tell the user to refresh `jira.token`
  (the Atlassian token is shared with Jira on Cloud)
- `404` → wrong space key, page id, or the user lacks read access
- `403` → space-level permission denied

## Anti-patterns

- Don't fetch HTML and paste it raw into a chat reply — strip tags first
- Don't write a token into a Confluence page (it gets indexed)
- Don't conflate the legacy `/wiki/rest/api` and v2 `/wiki/api/v2` paths;
  pick one per call
