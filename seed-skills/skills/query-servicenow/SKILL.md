---
name: query-servicenow
description: "Query ServiceNow via REST API using SNOW_INSTANCE + SNOW_USER + SNOW_PASS env vars."
---

# Query ServiceNow

The Hive Secret Store injects ServiceNow credentials at spawn time. Use
them to query incidents, change requests, the CMDB, and RITMs via curl.

## Required env vars (auto-injected)

| Env var | What it is |
|---|---|
| `SNOW_INSTANCE` | Instance hostname (e.g. `mycompany.service-now.com`) |
| `SNOW_USER` | API user name |
| `SNOW_PASS` | API user password / app-password |

If any of these are unset, the Secret Store hasn't been populated — say so
and stop.

## Auth pattern

ServiceNow uses Basic auth on the REST API:

```bash
AUTH="${SNOW_USER}:${SNOW_PASS}"
BASE="https://${SNOW_INSTANCE}/api/now"
COMMON_HEADERS=(-H 'Accept: application/json' -H 'Content-Type: application/json')
```

## Tables (the REST API is table-based)

| Table | What it holds |
|---|---|
| `incident` | P1/P2/P3 incidents |
| `change_request` | CHGs (CAB approvals, planned work) |
| `cmdb_ci_server` | Server / VM CIs (CMDB) |
| `sc_req_item` | RITMs (catalog items) |
| `sys_user` | Users / approvers |

## Common operations

### Get a single record by sys_id

```bash
SYS_ID="$1"
curl -sS -u "$AUTH" "${COMMON_HEADERS[@]}" \
  "${BASE}/table/incident/${SYS_ID}" |
  jq '.result | {number, short_description, priority, state, assigned_to: .assigned_to.display_value}'
```

### Search by query (sysparm_query)

```bash
# Open P1/P2 incidents assigned to my team
curl -sS -u "$AUTH" "${COMMON_HEADERS[@]}" -G \
  --data-urlencode 'sysparm_query=active=true^priorityIN1,2^assignment_group.name=Cloud Ops' \
  --data-urlencode 'sysparm_fields=number,short_description,priority,state,opened_at' \
  --data-urlencode 'sysparm_limit=20' \
  "${BASE}/table/incident" |
  jq '.result[]'
```

### Find a host in the CMDB

```bash
HOSTNAME="$1"
curl -sS -u "$AUTH" "${COMMON_HEADERS[@]}" -G \
  --data-urlencode "sysparm_query=name=${HOSTNAME}" \
  --data-urlencode 'sysparm_fields=name,fqdn,ip_address,os,owned_by.display_value,support_group.display_value' \
  "${BASE}/table/cmdb_ci_server" |
  jq '.result[0]'
```

### Open a change request (CHG)

```bash
PAYLOAD=$(jq -n \
  --arg short "Decommission vm-prod-43" \
  --arg desc  "L1 triage attached. Snapshot retained 30d." \
  --arg ci    "$CMDB_SYS_ID" \
  '{short_description: $short, description: $desc, cmdb_ci: $ci, type: "standard", category: "Hardware"}')

curl -sS -u "$AUTH" "${COMMON_HEADERS[@]}" \
  -X POST -d "$PAYLOAD" \
  "${BASE}/table/change_request" |
  jq '.result | {sys_id, number, state}'
```

### Poll a CHG for approval

```bash
NUMBER="$1"
curl -sS -u "$AUTH" "${COMMON_HEADERS[@]}" -G \
  --data-urlencode "sysparm_query=number=${NUMBER}" \
  --data-urlencode 'sysparm_fields=number,state,approval,approval_history' \
  "${BASE}/table/change_request" |
  jq '.result[0] | {state, approval}'
# state values: -5=new, -4=assess, -3=authorize, -2=scheduled,
# -1=implement, 0=review, 3=closed, 4=cancelled
```

### Add a work note to an incident

```bash
SYS_ID="$1"
NOTE="$2"
curl -sS -u "$AUTH" "${COMMON_HEADERS[@]}" \
  -X PATCH -d "$(jq -n --arg n "$NOTE" '{work_notes: $n}')" \
  "${BASE}/table/incident/${SYS_ID}"
```

## Errors

- `401` → wrong creds; refresh `SNOW_USER` / `SNOW_PASS` in the Secrets
  screen
- `403` → user role lacks the `rest_api` ACL on this table
- `400` → malformed query; check `sysparm_query` operators (`^=^!=^IN`)

## Anti-patterns

- Don't paginate manually for 5000-row tables — use `sysparm_limit` +
  `sysparm_offset`, or pin a `sys_created_on >=` filter
- Don't write the password to logs; the env var is the only home it gets
- For destructive ops (terminating CIs, cancelling CHGs), always double-
  check the `sys_id` first — there's no undo
