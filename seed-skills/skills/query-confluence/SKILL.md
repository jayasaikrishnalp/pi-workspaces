---
name: query-confluence
description: "Query Confluence via the mcp-atlassian MCP server (preferred) or direct REST API. Tool-first — always try MCP before curl."
---

# Query Confluence

The Hive workspace runs an `mcp-atlassian` MCP server (when `uvx` is
installed and Confluence creds are in the Secret Store). The same
server hosts both Jira AND Confluence tools — the MCP appears as
`atlassian` in the broker.

## When to use

Anything Confluence: searching pages, fetching content, creating /
updating pages, listing children, attaching labels, navigating spaces.

## Mode 1 — MCP (preferred)

Use the `mcp__atlassian__confluence_*` tool family.

| Tool | When to call it |
|---|---|
| `confluence_search` | CQL-driven search (`text ~ "outage runbook" AND type = page`) |
| `confluence_get_page` | Fetch a page by id (storage / view representation) |
| `confluence_get_page_children` | List child pages of a parent |
| `confluence_get_page_history` | Version history |
| `confluence_get_page_diff` | Diff between two versions |
| `confluence_get_space_page_tree` | Whole-space hierarchy |
| `confluence_create_page` | Create a new page |
| `confluence_update_page` | Update an existing page (preserves history; bumps version) |
| `confluence_move_page` | Re-parent a page |
| `confluence_delete_page` | Remove a page (use sparingly) |
| `confluence_add_label` / `confluence_get_labels` | Tag / list tags |
| `confluence_add_comment` / `confluence_reply_to_comment` / `confluence_get_comments` | Comments thread |
| `confluence_upload_attachment` / `confluence_download_attachment` / `confluence_get_attachments` | Attachments |
| `confluence_get_page_views` | Page popularity / view stats |
| `confluence_search_user` | Find a user by name / email |

Common patterns:

**Find a runbook:**
```
confluence_search(query="text ~ \"RDS failover runbook\" AND type = page", limit=10)
```

**Read a known page:**
```
confluence_get_page(page_id="123456789")
```

**Publish a new runbook (creates a page in space `OPS` under parent `654321`):**
```
confluence_create_page(
  space_id="OPS",
  parent_id="654321",
  title="Compliance Dashboard — Runbook",
  body="# Overview\n\n…",
  representation="storage"
)
```

**Tag for the catalog:**
```
confluence_add_label(page_id="123456789", labels=["ComplianceDashboard", "Orca"])
```

## Mode 2 — curl fallback

Confluence Cloud uses Basic auth on `email:api_token`. Env vars (auto-
injected from the Secret Store):

| Env var | What it is |
|---|---|
| `CONFLUENCE_URL` | Site (e.g. `https://wkengineering.atlassian.net/wiki`) |
| `CONFLUENCE_USERNAME` | Email of the API token owner |
| `CONFLUENCE_API_TOKEN` | API token (same one as Jira on Atlassian Cloud) |

Aliases also injected: `CONFLUENCE_BASE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`.

```bash
AUTH="${CONFLUENCE_USERNAME}:${CONFLUENCE_API_TOKEN}"
BASE="${CONFLUENCE_URL%/}"

# CQL search
curl -sS -u "$AUTH" -G \
  --data-urlencode "cql=text ~ \"${QUERY}\" AND type = page" \
  --data-urlencode 'limit=10' \
  "${BASE}/rest/api/content/search" |
  jq '.results[] | {id, title, url: ._links.webui}'

# Page by id (storage representation)
curl -sS -u "$AUTH" \
  "${BASE}/api/v2/pages/${PAGE_ID}?body-format=storage" |
  jq '{id, title, body: .body.storage.value}'

# Plain-text view
curl -sS -u "$AUTH" \
  "${BASE}/rest/api/content/${PAGE_ID}?expand=body.view" |
  jq -r '.body.view.value' | sed 's/<[^>]*>//g' | sed '/^$/d'

# Find by title in a space
curl -sS -u "$AUTH" -G \
  --data-urlencode "spaceKey=${SPACE_KEY}" \
  --data-urlencode "title=${TITLE}" \
  --data-urlencode 'expand=body.view' \
  "${BASE}/rest/api/content" |
  jq '.results[0] | {id, title, body: .body.view.value}'

# Add a comment to a page
curl -sS -u "$AUTH" \
  -X POST -H 'Content-Type: application/json' \
  -d "$(jq -Rn --arg pid "$PAGE_ID" --arg body "$COMMENT" \
    '{type:"comment", container:{type:"page", id:$pid}, body:{storage:{value:("<p>"+$body+"</p>"), representation:"storage"}}}')" \
  "${BASE}/rest/api/content"
```

## Detection

```bash
if command -v uvx >/dev/null && [ -n "${CONFLUENCE_URL}" ]; then
  echo "MCP available — call mcp__atlassian__confluence_* tools"
else
  echo "MCP unavailable — fall back to curl"
fi
```

## Errors

- `401` — token wrong / expired; refresh via Hive Secrets screen
- `404` — wrong space key / page id, or you lack read access
- `403` — space-level permission denied

## Anti-patterns

- Don't paste rendered HTML raw into a chat reply — strip tags first
- Don't write tokens into Confluence pages (they get indexed)
- Don't conflate the legacy `/rest/api/content` and v2 `/api/v2/pages`
  paths — pick one shape per call
- Don't forget that `confluence_update_page` requires the version
  number; fetch with `confluence_get_page` first to get `version.number`
  and pass `version + 1`
