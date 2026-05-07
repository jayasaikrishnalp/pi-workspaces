---
name: query-jira
description: "Query Jira via the mcp-atlassian MCP server (preferred) or direct REST API. Tool-first — always try MCP before curl."
---

# Query Jira

The Hive workspace runs an `mcp-atlassian` MCP server alongside pi (when
`uvx` is installed and Jira credentials are in the Secret Store). When
you need to read or modify Jira issues, **always prefer the MCP tools**
— they're faster, type-checked, and authenticate exactly the same way
the user's Atlassian Cloud session does. Fall back to curl only when
the MCP server is unavailable.

## When to use

Trigger this skill any time the user asks about a Jira ticket, an
assignee's queue, comments, transitions, sprints, components, or
anything else under Jira. Examples:

- "Pick up the highest-priority ticket assigned to me"
- "Summarize GHCOS-14216"
- "Move PROJ-123 to In Review and add a comment with the PR URL"
- "What's blocking ABC-9 right now?"

## Mode 1 — MCP (preferred)

The `atlassian` MCP server is registered automatically in
`src/server/mcp-config.ts` and proxies to the `mcp-atlassian` Python
package. Call its tools directly — they appear under the
`mcp__atlassian__*` namespace.

| Tool | When to call it |
|---|---|
| `jira_get_issue` | Fetch one ticket by key (summary, description, status, priority, assignee, etc.) |
| `jira_search` | JQL-driven search (`assignee = currentUser()`, `priority = High`, etc.) |
| `jira_get_transitions` | Discover available status transitions for a ticket |
| `jira_transition_issue` | Move a ticket through workflow (Start progress, Done, Cancelled) |
| `jira_add_comment` | Append a comment |
| `jira_edit_comment` | Edit an existing comment |
| `jira_update_issue` | Change fields (summary, priority, labels, etc.) |
| `jira_create_issue` | Open a new ticket |
| `jira_create_issue_link` | Link two issues (blocks, relates, etc.) |
| `jira_get_sprint_issues` / `jira_get_sprints_from_board` | Board / sprint browsing |
| `jira_add_worklog` | Time tracking |

Quick reference for the "highest-priority assigned ticket" use case:

```
jira_search(jql="assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, created DESC", limit=1)
```

Then for the picked ticket:

```
jira_get_issue(issue_key="<KEY>", fields="summary,status,priority,description,assignee,labels,components")
jira_get_transitions(issue_key="<KEY>")
```

When transitioning, ALWAYS call `jira_get_transitions` first — the
transition `id` is project-specific. Pick the one whose `name` matches
your intent.

## Mode 2 — curl fallback

When the MCP server is not available (e.g. `uvx` not on PATH, or the
broker reports `atlassian: error`), fall back to direct REST. The
Secret Store flat-key passthrough injects these env vars into the pi
child verbatim:

| Env var | What it is |
|---|---|
| `JIRA_URL` | Atlassian site (e.g. `https://wkengineering.atlassian.net`) |
| `JIRA_USERNAME` | Email of the API token owner |
| `JIRA_API_TOKEN` | Personal API token |

If any are unset, the Secret Store hasn't been populated — say so and
stop. Don't guess endpoints.

```bash
AUTH="${JIRA_USERNAME}:${JIRA_API_TOKEN}"

# Get a single issue
curl -sS -u "$AUTH" -H 'Accept: application/json' \
  "${JIRA_URL}/rest/api/3/issue/${KEY}" |
  jq '{key, summary: .fields.summary, status: .fields.status.name, priority: .fields.priority.name, assignee: .fields.assignee.displayName, description: .fields.description}'

# Find issues assigned to me, sorted by priority
JQL='assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, created DESC'
curl -sS -u "$AUTH" -G \
  --data-urlencode "jql=${JQL}" \
  --data-urlencode 'fields=summary,status,priority' \
  --data-urlencode 'maxResults=20' \
  "${JIRA_URL}/rest/api/3/search" |
  jq '.issues[] | {key, summary: .fields.summary, status: .fields.status.name, priority: .fields.priority.name}'

# Comment on a ticket
curl -sS -u "$AUTH" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"body\": {\"type\": \"doc\", \"version\": 1, \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": $(jq -Rn --arg s "$COMMENT" '$s')}]}]}}" \
  "${JIRA_URL}/rest/api/3/issue/${KEY}/comment"

# Transition a ticket — list available transitions first
curl -sS -u "$AUTH" "${JIRA_URL}/rest/api/3/issue/${KEY}/transitions" | jq '.transitions[] | {id, name}'
curl -sS -u "$AUTH" -X POST -H 'Content-Type: application/json' \
  -d '{"transition": {"id": "31"}}' \
  "${JIRA_URL}/rest/api/3/issue/${KEY}/transitions"
```

## Detection

To pick the mode:

```bash
if command -v uvx >/dev/null && [ -n "${JIRA_URL}" ]; then
  echo "MCP available — call mcp__atlassian__jira_* tools"
else
  echo "MCP unavailable — fall back to curl"
fi
```

## Description rendering (curl mode)

Jira description is in ADF (Atlassian Document Format) JSON. To get
readable text:

```bash
curl -sS -u "$AUTH" \
  "${JIRA_URL}/rest/api/3/issue/${KEY}?expand=renderedFields" |
  jq -r '.renderedFields.description' | sed 's/<[^>]*>//g'
```

The MCP `jira_get_issue` already returns ADF parsed — no post-processing
required.

## Errors

- `401 Unauthorized` — token wrong; surface and ask the user to refresh
  `jira.token` (or `JIRA_API_TOKEN`) in the Hive Secrets screen
- `403 Forbidden` — token lacks permission on this project
- `404 Not Found` — wrong issue key OR project requires login

## Anti-patterns

- Don't `cat ~/.jira` or look for a CLI — env vars and the MCP server
  are the only sources of truth
- Don't paste tokens into comments, logs, or wiki pages
- Don't fall back to "I don't have Jira access" — the workspace has
  configured this on your behalf, exactly so you don't have to. If
  both modes fail, surface the specific failure (which env var was
  empty, what the MCP broker error was) instead.
- Don't hard-code transition ids across projects — different Jira
  projects use different ids; always discover them via
  `jira_get_transitions`
