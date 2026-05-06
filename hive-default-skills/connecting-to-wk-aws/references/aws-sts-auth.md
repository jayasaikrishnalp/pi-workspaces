# AWS STS Role Assumption Reference

## Authentication Method

### Credential Source

The AWS CLI follows its standard credential chain. In Hive, the **preferred**
source is environment variables populated from the Secret Store under the
`aws.*` prefix:

| Hive secret key | Env var the CLI reads |
|---|---|
| `aws.access_key_id` | `AWS_ACCESS_KEY_ID` |
| `aws.secret_access_key` | `AWS_SECRET_ACCESS_KEY` |
| `aws.session_token` (optional) | `AWS_SESSION_TOKEN` |
| `aws.region` | `AWS_DEFAULT_REGION` |

When env vars are present, the CLI uses them automatically — no `--profile`
flag is required (or wanted).

The legacy fallback is a `[WK-PROFILE]` section in `~/.aws/credentials`.
Activate it with `export AWS_PROFILE=WK-PROFILE`.

### STS Assume Role via Master Account
The master account creds (sourced as above) are used to look up role ARNs in
DynamoDB, then assume the target role via STS.

```bash
aws sts assume-role \
  --role-arn "arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME" \
  --role-session-name wk-session \
  --output json
```

### Token Lifetime
- STS assumed role sessions: **1 hour** by default
- Master account credentials: rotated whenever the secret store entries are
  updated. No expiry as long as the IAM keys remain active.

## WK-FedRoles DynamoDB Table

- **Table**: `WK-FedRoles`
- **Region**: `us-east-1`
- **Master Account**: `<MASTER_ACCOUNT_ID>` — resolve at runtime via
  `aws sts get-caller-identity --profile WK-PROFILE`
- **Partition Key**: `AccountFedRole` (format: `{AccountNumber}-WKFedRoles-{RoleType}`)

### Lookup by Account
```bash
aws dynamodb scan --table-name WK-FedRoles --region us-east-1 \
  --filter-expression "AccountNumber = :acct" \
  --expression-attribute-values '{":acct": {"S": "ACCOUNT_NUMBER"}}' \
  --query 'Items[].{Role:AccountFedRole.S,ARN:ARN.S}' \
  --output table
```

### Direct Key Lookup
```bash
aws dynamodb get-item --table-name WK-FedRoles --region us-east-1 \
  --key '{"AccountFedRole": {"S": "ACCOUNT_NUMBER-WKFedRoles-Operations"}}' \
  --query 'Item.ARN.S' --output text
```

## Role Types

| Role | Purpose | When to Use |
|------|---------|-------------|
| **Operations** | Day-to-day infra ops (EC2, S3, Lambda, etc.) | **DEFAULT** for all general operations |
| **Admin** | Full administrative access | IAM/org-level tasks, when Operations lacks perms |
| **Architect** | Architecture and design access | VPC planning, CloudFormation |
| **Read** | Read-only access | Auditing, reporting, investigation |
| **Billing** | Billing and cost management | Cost analysis, budget checks |
| **DNS** | Route53 and DNS management | DNS record changes, hosted zones |

## Common AWS Commands After Connection

### Compute
```bash
aws ec2 describe-instances --region us-east-1 --output table
aws ec2 describe-instances --filters "Name=instance-state-name,Values=running" --output table
aws lambda list-functions --output table
```

### Storage
```bash
aws s3 ls
aws s3api list-buckets --output table
```

### Networking
```bash
aws ec2 describe-vpcs --output table
aws ec2 describe-security-groups --output table
aws elbv2 describe-load-balancers --output table
```

### IAM
```bash
aws iam list-roles --output table
aws iam list-users --output table
```

### CloudFormation
```bash
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --output table
```

## Multi-Region Operations
```bash
REGIONS=$(aws ec2 describe-regions --query 'Regions[].RegionName' --output text)
for region in $REGIONS; do
  echo "=== $region ==="
  aws ec2 describe-instances --region "$region" --output table
done
```

## Error Codes

| Error | Meaning |
|-------|---------|
| `ExpiredTokenException` | STS session expired (>1 hour) — re-assume the role |
| `AccessDenied` on assume-role | WK-PROFILE credentials invalid or expired |
| `AccessDenied` on operation | Current role lacks permission — try Admin role |
| `InvalidIdentityToken` | Clock skew or malformed token |
| `MalformedPolicyDocument` | Role trust policy issue (account-level fix needed) |
| `RegionDisabledException` | Region not enabled for this account |

## Critical Rules

1. **Assume + execute in ONE Bash call** — env vars are lost between Bash invocations
2. **No `--profile` flags** — the credential chain (env vars first, then file) handles routing automatically
3. **Master credentials run the DynamoDB lookup**; assume-role swaps them for the target role's temp creds in the same shell
4. **Default to Operations role** unless the task specifically requires another type
5. **Re-assume role** if commands fail after extended operations (token expiry)
