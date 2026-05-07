---
name: query-servicenow
description: "Query ServiceNow via the servicenow MCP server (preferred) or direct REST API. Tool-first — always try MCP before curl."
---

# Query ServiceNow

The Hive workspace runs a `servicenow` MCP server alongside pi (when
`SNOW_INSTANCE` + `SNOW_USER` + `SNOW_PASS` are in the Secret Store).
When you need to read or modify ServiceNow records, **always prefer
the MCP tools** — they're faster, type-checked, handle the multi-field
gotchas (e.g. `state=6` requiring `close_code` + `close_notes` +
`assigned_to` together), and authenticate exactly the same way the
user's SNOW session does. Fall back to curl only when the MCP server
is unavailable.

## When to use

Trigger this skill any time the user asks about a SNOW record —
incidents, change requests, RITMs, the CMDB, or users — or asks you
to perform an action on one. Examples:

- "Look up RITM1873427 and tell me who requested it"
- "Show me open P1/P2 incidents assigned to Cloud Ops"
- "Resolve INC0012345 with close note 'rebooted, root cause patched'"
- "Find the CMDB entry for vm-prod-43 and the open change requests
  touching it"

## Mode 1 — MCP (preferred)

The `servicenow` MCP server is registered automatically in
`src/server/mcp-config.ts` and runs from
`extensions/servicenow-mcp/server.ts`. Its tools appear under the
`mcp__servicenow__*` namespace. The instance URL is read from
`SNOW_INSTANCE` at every call — never hard-coded.

| Tool | When to call it |
|---|---|
| `get_incident` | Fetch one incident by `number` (e.g. `INC0012345`) or `sys_id` |
| `search_incidents` | SNOW encoded query, e.g. `active=true^priorityIN1,2` |
| `create_incident` | Open a new incident with `short_description` (+ optional caller, group, priority, etc.) |
| `update_incident` | PATCH arbitrary fields by `number` or `sys_id` |
| `resolve_incident` | Close as state=6 with `close_code` + `close_notes` + `assigned_to` (the four-field quartet SNOW requires together — the tool enforces this) |
| `assign_ticket` | Set `assigned_to` / `assignment_group` on any task table (`incident`, `change_request`, `change_task`, `sc_req_item`, `sc_task`, `problem`, `task`) |
| `find_user` | Look up a `sys_user` by name / email / user_name with a 7-strategy fallback |
| `find_server` | CMDB lookup by hostname (covers `cmdb_ci_server` and `cmdb_ci_computer`) |
| `get_changes_for_host` | Change requests touching a host within a date window |
| `list_tasks_for_ci` | Walk `task_ci → task` for a hostname/CI sys_id |
| `get_ritm` | Fetch a Request Item (RITM) by number; optionally pull catalog variables |

### Quick-reference invocations

Look up a RITM and its requester:

```
mcp__servicenow__get_ritm({ number: "RITM1873427" })
```

Find the highest-priority open incidents:

```
mcp__servicenow__search_incidents({
  query: "active=true^priorityIN1,2^ORDERBYpriority",
  limit: 20,
})
```

Resolve an incident (the tool refuses if `close_code` /
`close_notes` are missing — SNOW would reject the PATCH otherwise):

```
mcp__servicenow__resolve_incident({
  number: "INC0012345",
  close_code: "Solved (Permanently)",
  close_notes: "rebooted, root cause patched in CHG987",
  assigned_to: "ado_integration_user",
})
```

Find a user before assigning:

```
mcp__servicenow__find_user({ q: "Jane Q Smith" })
// → { strategy: "...", count: 1, results: [{ sys_id, user_name, email, ... }] }
```

## Mode 2 — curl fallback

When the MCP server is not available (broker reports `servicenow:
error`, or `SNOW_INSTANCE` is empty), fall back to direct REST. The
Secret Store flat-key passthrough injects these env vars verbatim:

| Env var | What it is |
|---|---|
| `SNOW_INSTANCE` | Instance hostname or full URL (`mycompany.service-now.com` or `https://mycompany.service-now.com`) |
| `SNOW_USER` | API user name (or email for OAuth-token users) |
| `SNOW_PASS` | Password / API token |

If any are unset, the Secret Store hasn't been populated — say so
and stop. Don't guess endpoints. Don't hard-code the URL.

```bash
# Normalize the instance to a full origin so curl works for both
# "mycompany.service-now.com" and "https://mycompany.service-now.com".
case "$SNOW_INSTANCE" in
  http://*|https://*) ORIGIN="$SNOW_INSTANCE" ;;
  *) ORIGIN="https://${SNOW_INSTANCE}" ;;
esac
BASE="${ORIGIN%/}/api/now"
AUTH="${SNOW_USER}:${SNOW_PASS}"

# Get a single incident by number
NUMBER="INC0012345"
curl -sS -u "$AUTH" -H 'Accept: application/json' -G \
  --data-urlencode "sysparm_query=number=${NUMBER}" \
  --data-urlencode 'sysparm_display_value=true' \
  "${BASE}/table/incident" |
  jq '.result[0] | {number, short_description, state: .state.display_value, priority, assigned_to: .assigned_to.display_value}'

# Get a RITM
RITM="RITM1873427"
curl -sS -u "$AUTH" -H 'Accept: application/json' -G \
  --data-urlencode "sysparm_query=number=${RITM}" \
  --data-urlencode 'sysparm_display_value=true' \
  "${BASE}/table/sc_req_item" |
  jq '.result[0] | {number, short_description, stage: .stage.display_value, requested_for: .requested_for.display_value, state: .state.display_value}'

# Resolve an incident — SNOW requires state + close_code + close_notes
# together, AND the record needs an assigned_to. Send all four in one
# PATCH; otherwise it returns 400 "Validation failed for fields".
curl -sS -u "$AUTH" -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -X PATCH \
  -d '{"state":"6","close_code":"Solved (Permanently)","close_notes":"rebooted","assigned_to":"ado_integration_user"}' \
  "${BASE}/table/incident/${SYS_ID}"

# CMDB host lookup
HOSTNAME="vm-prod-43"
curl -sS -u "$AUTH" -H 'Accept: application/json' -G \
  --data-urlencode "sysparm_query=name=${HOSTNAME}" \
  --data-urlencode 'sysparm_display_value=true' \
  "${BASE}/table/cmdb_ci_server" |
  jq '.result[0] | {sys_id, name, ip_address, os, owned_by: .owned_by.display_value, support_group: .support_group.display_value}'
```

## Detection

To pick the mode:

```bash
if [ -n "${SNOW_INSTANCE}" ] && [ -n "${SNOW_USER}" ] && [ -n "${SNOW_PASS}" ]; then
  # MCP available iff the broker started the servicenow server. Check via
  # /api/mcp/servers when running inside pi:
  echo "MCP available — call mcp__servicenow__* tools"
else
  echo "SNOW creds missing — Secret Store not populated"
fi
```

## State-value cheat sheet

ServiceNow stores states as numeric codes; `sysparm_display_value=true`
returns labels, but for queries you write the numbers:

| Table | Code | Meaning |
|---|---|---|
| `incident` | 1 | New |
| `incident` | 2 | In Progress |
| `incident` | 3 | On Hold |
| `incident` | 6 | Resolved |
| `incident` | 7 | Closed |
| `incident` | 8 | Canceled |
| `change_request` | -5/-4/-3/-2 | New / Assess / Authorize / Scheduled |
| `change_request` | -1 | Implement |
| `change_request` | 0 | Review |
| `change_request` | 3/4 | Closed / Cancelled |
| `sc_req_item` | 1/2/3/4/7 | Open / Work in Progress / Closed Complete / Closed Incomplete / Closed Skipped |

## Errors

- `401 Unauthorized` → wrong creds; refresh `SNOW_USER` / `SNOW_PASS`
  in the Hive Secrets screen (look for doubled passwords from a paste
  mistake)
- `403 Forbidden` → user role lacks the `rest_api` / table ACL —
  the SNOW admin needs to grant it
- `400 Validation failed for fields …` on a resolve PATCH → you
  forgot one of the quartet (state=6, close_code, close_notes,
  assigned_to). The MCP `resolve_incident` enforces this for you;
  if you're on the curl fallback, send all four in the same body.
- `404` → wrong number / sys_id, or the user lacks read on the row

## Anti-patterns

- Don't `cat ~/.servicenow` or look for a CLI — env vars and the MCP
  server are the only sources of truth
- Don't hard-code the SNOW host (e.g. `https://wkengineering.service-now.com`).
  Always read from `SNOW_INSTANCE` so dev/prod swaps via the Secrets
  screen take effect immediately.
- Don't paste passwords into work notes, comments, or logs
- Don't try to set `state=7` (closed) directly — close incidents
  through `state=6` (resolved) with the proper quartet; SNOW closes
  resolved tickets automatically after a delay
- Don't paginate manually for 5000-row tables — use `sysparm_limit` +
  `sysparm_offset`, or pin a `sys_created_on >=` filter
- Don't fall back to "I don't have ServiceNow access" — the workspace
  has configured this on your behalf. If both modes fail, surface
  the specific failure (which env var was empty, what the MCP broker
  error was) instead.
