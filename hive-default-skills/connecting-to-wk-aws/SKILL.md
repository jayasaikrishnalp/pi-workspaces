---
name: connecting-to-wk-aws
description: Connect to any Wolter Kluwer (WK) AWS account by assuming federated roles. Activate when the user says "connect to wk-account", "wk acc", "wolter kluwer account", or references any WK AWS account number for operations. Also activates when user asks to perform any AWS operation (list instances, create resources, check billing, etc.) on a WK account.
---

# Connecting to WK AWS Accounts

This skill handles federated role assumption into any Wolter Kluwer (WK) AWS account using the centralized WK-FedRoles DynamoDB table.

## Architecture

```
Master Account (835377776149)          Target WK Account
┌─────────────────────────┐           ┌──────────────────────┐
│  ~/.aws/credentials     │           │                      │
│  [WK-PROFILE]           │──STS──►   │  WKFedRoles-*-XXXXX  │
│  AKIA4FADFIYKY5GPBHOA   │ assume    │  (IAM Roles)         │
│                         │  role     │                      │
│  DynamoDB: WK-FedRoles  │           └──────────────────────┘
│  (role lookup table)    │
└─────────────────────────┘
```

## Configuration

- **AWS Profile**: `WK-PROFILE` (in `~/.aws/credentials`)
- **Master Account**: `835377776149`
- **DynamoDB Table**: `WK-FedRoles` (region: `us-east-1`)
- **Default Region**: `us-east-1`
- **Restore/Secondary Region**: `us-west-2`
- **Helper Script**: `templates/wk-assume-role.sh`
- **Reference Docs**: `references/aws-sts-auth.md`

## WK-FedRoles Table Schema

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `AccountFedRole` | String (Partition Key) | `{AccountNumber}-WKFedRoles-{RoleType}` | `913524925851-WKFedRoles-Operations` |
| `AccountNumber` | String | 12-digit AWS account ID | `913524925851` |
| `RoleName` | String | IAM role name with unique suffix | `WKFedRoles-Operations-k0wgMw2MbVLL` |
| `ARN` | String | Full IAM role ARN | `arn:aws:iam::913524925851:role/WKFedRoles-Operations-k0wgMw2MbVLL` |

## Available Role Types

| Role | Purpose | When to Use |
|------|---------|-------------|
| **Operations** | Day-to-day infra operations (EC2, S3, Lambda, etc.) | **DEFAULT** — use for all general AWS operations |
| **Admin** | Full administrative access | When Operations role lacks permissions, or for IAM/org-level tasks |
| **Architect** | Architecture and design access | Infrastructure design, VPC planning, CloudFormation |
| **Read** | Read-only access | Auditing, reporting, investigating without risk of changes |
| **Billing** | Billing and cost management | Cost analysis, billing reports, budget checks |
| **DNS** | Route53 and DNS management | DNS record changes, hosted zone management |

## Connection Workflow

### Step 1: Look Up Roles for the Target Account

```bash
aws dynamodb scan --table-name WK-FedRoles --profile WK-PROFILE --region us-east-1 \
  --filter-expression "AccountNumber = :acct" \
  --expression-attribute-values '{":acct": {"S": "ACCOUNT_NUMBER"}}' \
  --query 'Items[].{Role:AccountFedRole.S,ARN:ARN.S}' \
  --output table
```

### Step 2: Assume the Appropriate Role

Select the role based on the task:
- General operations (list/create/modify resources) → **Operations**
- Need elevated access or IAM changes → **Admin**
- Just reading/auditing → **Read**
- Cost/billing inquiries → **Billing**
- DNS changes → **DNS**

```bash
CREDS=$(aws sts assume-role \
  --role-arn "ROLE_ARN_FROM_STEP_1" \
  --role-session-name wk-session \
  --profile WK-PROFILE \
  --output json)

export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['Credentials']['AccessKeyId'])")
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['Credentials']['SecretAccessKey'])")
export AWS_SESSION_TOKEN=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['Credentials']['SessionToken'])")
```

### Step 3: Execute AWS Commands

**CRITICAL**: The assumed role credentials are environment variables and only live within a single Bash tool call. You MUST combine the assume-role AND the actual AWS command(s) in the **same single Bash invocation**. If you split them across separate Bash calls, the credentials will be lost and commands will fail silently or use wrong credentials.

```bash
# CORRECT — assume + execute in ONE Bash call
CREDS=$(aws sts assume-role --role-arn "ROLE_ARN" --role-session-name wk-session --profile WK-PROFILE --output json) && \
export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['Credentials']['AccessKeyId'])") && \
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['Credentials']['SecretAccessKey'])") && \
export AWS_SESSION_TOKEN=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['Credentials']['SessionToken'])") && \
aws ec2 describe-instances --region us-east-1 ...
```

```bash
# WRONG — credentials lost between calls
# Bash call 1: assume role and export (credentials vanish after this call ends)
# Bash call 2: aws ec2 describe-instances (uses default profile, NOT assumed role)
```

### Step 4: Session Expiry Handling

STS assumed role sessions expire after **1 hour** by default. If a command fails with an auth error or returns unexpected empty results, re-assume the role in the same Bash call before retrying.

## Trigger Phrases

Activate this skill when the user says any of:
- "connect to wk-account" / "wk acc" / "wk account" / "wolter kluwer account"
- "connect to {account_number}" (any 12-digit AWS account)
- "list instances in wk account {number}"
- "check {resource} in {account_number}"
- Any AWS operation referencing a WK account number
- "assume role for {account_number}"
- "switch to account {number}"

## Multi-Region Operations

When user asks for "all regions" operations:

```bash
# Get all regions, then loop — ALL in one Bash call
REGIONS=$(aws ec2 describe-regions --query 'Regions[].RegionName' --output text)
for region in $REGIONS; do
  aws ec2 describe-instances --region "$region" ...
done
```

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| `ExpiredTokenException` | STS session expired | Re-assume the role |
| `AccessDenied` on assume-role | WK-PROFILE creds invalid | Check `~/.aws/credentials` [WK-PROFILE] |
| `AccessDenied` on operation | Role lacks permission | Try **Admin** role instead of **Operations** |
| Empty results unexpectedly | Credentials not in scope | Verify assume + command are in same Bash call |
| Account not found in DynamoDB | Account not onboarded to WK-FedRoles | Inform user, check account number |

## Important Notes

1. **Never use `--profile WK-PROFILE` for target account operations** — that's the master account. Always assume a role first.
2. **DynamoDB queries use `--profile WK-PROFILE`** — the WK-FedRoles table lives in the master account.
3. **Default to Operations role** unless the task specifically requires another role type.
4. **Always combine assume-role + commands in a single Bash call** to prevent credential loss between shell invocations.
5. **STS sessions are temporary** — re-assume if commands start failing after extended operations.
