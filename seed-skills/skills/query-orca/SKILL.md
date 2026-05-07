---
name: query-orca
description: "Query Orca Security via REST API using ORCA_API_URL + ORCA_API_TOKEN env vars (alerts, FIM, asset inventory)."
---

# Query Orca Security

The Hive Secret Store injects Orca credentials at spawn time. Use them to
query alerts (including FIM), the asset inventory, and Sonar findings via
curl.

## Required env vars (auto-injected)

| Env var | What it is |
|---|---|
| `ORCA_API_URL` | API root (e.g. `https://api.orcasecurity.io/api`) |
| `ORCA_API_TOKEN` | API token from Orca → Settings → API |

If either is unset, the Secret Store hasn't been populated — say so and
stop.

## Auth pattern

Orca uses a bearer token:

```bash
BASE="${ORCA_API_URL%/}"
COMMON=(-H "Authorization: Token ${ORCA_API_TOKEN}" -H 'Content-Type: application/json')
```

## Common operations

### List recent alerts (highest severity first)

```bash
curl -sS "${COMMON[@]}" -G \
  --data-urlencode 'limit=50' \
  --data-urlencode 'sort_by=score' \
  --data-urlencode 'sort_order=desc' \
  "${BASE}/alerts" |
  jq '.data[] | {alert_id, type, score, state, asset: .asset_name, finding: .description}'
```

### Get a specific alert by id

```bash
ALERT_ID="$1"
curl -sS "${COMMON[@]}" "${BASE}/alerts/${ALERT_ID}" |
  jq '.data | {alert_id, type, score, state, asset_name, asset_id, description, recommendation, last_seen}'
```

### Filter for FIM (File Integrity Monitoring) alerts

```bash
curl -sS "${COMMON[@]}" -G \
  --data-urlencode 'category=fim' \
  --data-urlencode 'state=open' \
  --data-urlencode 'limit=100' \
  "${BASE}/alerts" |
  jq '.data[] | {alert_id, asset: .asset_name, file_path: .findings.file_path, change: .findings.change_type, last_seen}'
```

### Search alerts by Sonar (custom query language)

```bash
QUERY='Alert with state in (open) and category = "fim" and severity in (high, critical)'
curl -sS "${COMMON[@]}" -X POST \
  -d "$(jq -n --arg q "$QUERY" '{query: $q, limit: 50}')" \
  "${BASE}/sonar/query" |
  jq '.data[]'
```

### Resolve / dismiss an alert

```bash
ALERT_ID="$1"
REASON="$2"
curl -sS "${COMMON[@]}" -X PUT \
  -d "$(jq -n --arg r "$REASON" '{state:"closed", resolution_reason:$r}')" \
  "${BASE}/alerts/${ALERT_ID}/state"
```

### List assets (e.g. all EC2 instances)

```bash
curl -sS "${COMMON[@]}" -G \
  --data-urlencode 'cloud_provider=aws' \
  --data-urlencode 'asset_type=vm' \
  --data-urlencode 'limit=100' \
  "${BASE}/inventory" |
  jq '.data[] | {asset_id, name, account: .cloud_account_id, region, os, last_seen}'
```

### Triage flow (typical)

1. Pull the alert: `GET /alerts/${ALERT_ID}`
2. Pull the asset: `GET /inventory?asset_id=${ASSET_ID}` for owner / region
3. (Optional) Cross-reference ServiceNow CMDB to find the on-call owner
   (use the `query-servicenow` skill).
4. Decide: dismiss, escalate to L2, or open a CHG to fix the underlying
   misconfiguration.

## Errors

- `401` → token expired or wrong; refresh `ORCA_API_TOKEN` in Hive Secrets
- `403` → token's role lacks read on this resource
- `429` → rate-limited; back off ~10s before retrying

## Anti-patterns

- Don't dismiss FIM alerts en masse — every one is a flagged file change.
  Inspect at least the path and the change type.
- Don't paste the API token into a log/runbook — the env var is the only
  home it gets.
- Don't synthesize asset details when the API has them; always fetch via
  `${BASE}/inventory` first.
