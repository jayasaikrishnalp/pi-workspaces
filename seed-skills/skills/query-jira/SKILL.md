---
name: query-jira
description: "Query Jira via REST API using JIRA_URL + JIRA_USERNAME + JIRA_API_TOKEN env vars."
---

# Query Jira

The Hive Secret Store injects Jira credentials into your environment at
spawn time. Use them to talk to Jira directly via curl — **do NOT** fall
back to "I don't have Jira access."

## Required env vars (auto-injected from Secret Store)

| Env var | What it is |
|---|---|
| `JIRA_URL` | Atlassian site (e.g. `https://wkengineering.atlassian.net`) |
| `JIRA_USERNAME` | Email of the API token owner |
| `JIRA_API_TOKEN` | Personal API token (Atlassian → Account Settings → Security) |

Aliases also set: `ATLASSIAN_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`,
`JIRA_TOKEN`. Use whichever you prefer.

If any of these are unset, the Secret Store hasn't been populated yet —
say so and stop. Don't guess endpoints.

## Auth pattern

Jira Cloud uses Basic auth with `email:api_token`:

```bash
AUTH="${JIRA_USERNAME}:${JIRA_API_TOKEN}"
```

## Common operations

### Get a single issue by key

```bash
KEY="${1:?usage: KEY=GHCOS-14216}"
curl -sS -u "$AUTH" \
  -H 'Accept: application/json' \
  "${JIRA_URL}/rest/api/3/issue/${KEY}" |
  jq '{key, summary: .fields.summary, status: .fields.status.name, priority: .fields.priority.name, assignee: .fields.assignee.displayName, description: .fields.description}'
```

### Find issues assigned to me, sorted by priority

```bash
JQL='assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, created DESC'
curl -sS -u "$AUTH" -G \
  --data-urlencode "jql=${JQL}" \
  --data-urlencode 'fields=summary,status,priority,duedate' \
  --data-urlencode 'maxResults=20' \
  "${JIRA_URL}/rest/api/3/search" |
  jq '.issues[] | {key, summary: .fields.summary, status: .fields.status.name, priority: .fields.priority.name}'
```

### Pick the highest-priority assigned ticket

```bash
JQL='assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC'
curl -sS -u "$AUTH" -G \
  --data-urlencode "jql=${JQL}" \
  --data-urlencode 'fields=summary,priority,description' \
  --data-urlencode 'maxResults=1' \
  "${JIRA_URL}/rest/api/3/search" |
  jq '.issues[0] | {key, summary: .fields.summary, priority: .fields.priority.name, description: .fields.description}'
```

### Comment on an issue

```bash
KEY="$1"
COMMENT="$2"
curl -sS -u "$AUTH" \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"body\": {\"type\": \"doc\", \"version\": 1, \"content\": [{\"type\": \"paragraph\", \"content\": [{\"type\": \"text\", \"text\": $(jq -Rn --arg s "$COMMENT" '$s')}]}]}}" \
  "${JIRA_URL}/rest/api/3/issue/${KEY}/comment"
```

### Transition an issue (resolve, reopen, etc.)

```bash
KEY="$1"
# 1. List available transitions
curl -sS -u "$AUTH" "${JIRA_URL}/rest/api/3/issue/${KEY}/transitions" | jq '.transitions[] | {id, name}'
# 2. Apply (replace 31 with your transition id)
curl -sS -u "$AUTH" -X POST -H 'Content-Type: application/json' \
  -d '{"transition": {"id": "31"}}' \
  "${JIRA_URL}/rest/api/3/issue/${KEY}/transitions"
```

## Description rendering

Jira description is in ADF (Atlassian Document Format) JSON. To get a
readable text version:

```bash
curl -sS -u "$AUTH" \
  "${JIRA_URL}/rest/api/3/issue/${KEY}?expand=renderedFields" |
  jq -r '.renderedFields.description' | sed 's/<[^>]*>//g'
```

## Errors

- `401 Unauthorized` — wrong token; ask the user to refresh `jira.token`
  in the Hive Secrets screen
- `403 Forbidden` — token lacks permission on this project
- `404 Not Found` — wrong issue key OR the project requires login

## Anti-patterns

- Don't `cat ~/.jira` or look for a CLI — the env vars are the source of
  truth
- Don't paste the token into a comment, log, or wiki page
- Don't construct the URL by hand for hosted Jira (`*.atlassian.net`); use
  `${JIRA_URL}` so it works for any tenant
