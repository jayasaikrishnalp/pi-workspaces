#!/bin/bash
# ============================================================================
# WK AWS Role Assumption Helper
# ============================================================================
# Usage:
#   source wk-assume-role.sh <ACCOUNT_NUMBER> [ROLE_TYPE]
#
# Arguments:
#   ACCOUNT_NUMBER  - 12-digit AWS account ID (e.g., 913524925851)
#   ROLE_TYPE       - Optional: Operations (default), Admin, Read, Billing, DNS, Architect
#
# Examples:
#   source wk-assume-role.sh 913524925851                  # Assumes Operations role
#   source wk-assume-role.sh 913524925851 Admin            # Assumes Admin role
#   source wk-assume-role.sh 913524925851 Read             # Assumes Read-only role
#
# After sourcing, AWS CLI commands will use the assumed role credentials.
# ============================================================================

set -euo pipefail

# --- Step 0: Ensure AWS CLI v2 is installed -------------------------------
# Idempotent: no-op when `aws` is already on PATH. Full install matrix in
# references/install-aws-cli.md. Designed to be safe to re-source.
if ! command -v aws >/dev/null 2>&1; then
    echo "[wk-aws] AWS CLI not found — installing..."
    if [[ "$(uname -s)" == "Darwin" ]]; then
        if command -v brew >/dev/null 2>&1; then
            brew install awscli
        else
            curl -fsSL "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o /tmp/AWSCLIV2.pkg
            sudo installer -pkg /tmp/AWSCLIV2.pkg -target /
            rm -f /tmp/AWSCLIV2.pkg
        fi
    elif [[ -f /etc/debian_version ]]; then
        sudo apt-get update -qq && sudo apt-get install -y -qq curl unzip
        curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip
        unzip -q -o /tmp/awscliv2.zip -d /tmp && sudo /tmp/aws/install --update
        rm -rf /tmp/aws /tmp/awscliv2.zip
    elif [[ -f /etc/redhat-release || -f /etc/system-release ]]; then
        sudo yum install -y -q unzip curl
        curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip
        unzip -q -o /tmp/awscliv2.zip -d /tmp && sudo /tmp/aws/install --update
        rm -rf /tmp/aws /tmp/awscliv2.zip
    else
        echo "ERROR: unsupported OS — see references/install-aws-cli.md"
        return 1 2>/dev/null || exit 1
    fi
fi

# --- Configuration ---
WK_PROFILE="WK-PROFILE"
WK_REGION="us-east-1"
FEDROLES_TABLE="WK-FedRoles"
SESSION_NAME="wk-session"

# --- Input Validation ---
ACCOUNT_NUMBER="${1:-}"
ROLE_TYPE="${2:-Operations}"

if [[ -z "$ACCOUNT_NUMBER" ]]; then
    echo "ERROR: Account number is required."
    echo "Usage: source wk-assume-role.sh <ACCOUNT_NUMBER> [ROLE_TYPE]"
    return 1 2>/dev/null || exit 1
fi

if [[ ! "$ACCOUNT_NUMBER" =~ ^[0-9]{12}$ ]]; then
    echo "ERROR: Account number must be a 12-digit number. Got: $ACCOUNT_NUMBER"
    return 1 2>/dev/null || exit 1
fi

VALID_ROLES="Operations Admin Read Billing DNS Architect"
if [[ ! " $VALID_ROLES " =~ " $ROLE_TYPE " ]]; then
    echo "ERROR: Invalid role type '$ROLE_TYPE'. Valid options: $VALID_ROLES"
    return 1 2>/dev/null || exit 1
fi

# --- Step 1: Look up the role ARN from DynamoDB ---
echo "Looking up WKFedRoles-${ROLE_TYPE} for account ${ACCOUNT_NUMBER}..."

ROLE_ARN=$(aws dynamodb get-item \
    --table-name "$FEDROLES_TABLE" \
    --key "{\"AccountFedRole\": {\"S\": \"${ACCOUNT_NUMBER}-WKFedRoles-${ROLE_TYPE}\"}}" \
    --profile "$WK_PROFILE" \
    --region "$WK_REGION" \
    --query 'Item.ARN.S' \
    --output text 2>/dev/null)

if [[ -z "$ROLE_ARN" || "$ROLE_ARN" == "None" ]]; then
    echo "ERROR: No ${ROLE_TYPE} role found for account ${ACCOUNT_NUMBER} in WK-FedRoles."
    echo ""
    echo "Available roles for this account:"
    aws dynamodb scan \
        --table-name "$FEDROLES_TABLE" \
        --filter-expression "AccountNumber = :acct" \
        --expression-attribute-values "{\":acct\": {\"S\": \"${ACCOUNT_NUMBER}\"}}" \
        --profile "$WK_PROFILE" \
        --region "$WK_REGION" \
        --query 'Items[].AccountFedRole.S' \
        --output text 2>/dev/null || echo "  (could not retrieve roles)"
    return 1 2>/dev/null || exit 1
fi

echo "Found role: $ROLE_ARN"

# --- Step 2: Assume the role via STS ---
echo "Assuming role..."

CREDS=$(aws sts assume-role \
    --role-arn "$ROLE_ARN" \
    --role-session-name "$SESSION_NAME" \
    --profile "$WK_PROFILE" \
    --output json 2>&1)

if [[ $? -ne 0 ]]; then
    echo "ERROR: Failed to assume role."
    echo "$CREDS"
    return 1 2>/dev/null || exit 1
fi

# --- Step 3: Export credentials ---
export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['Credentials']['AccessKeyId'])")
export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['Credentials']['SecretAccessKey'])")
export AWS_SESSION_TOKEN=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['Credentials']['SessionToken'])")

EXPIRATION=$(echo "$CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['Credentials']['Expiration'])")

# --- Step 4: Verify ---
CALLER=$(aws sts get-caller-identity --output json 2>/dev/null)
ASSUMED_ACCOUNT=$(echo "$CALLER" | python3 -c "import sys,json; print(json.load(sys.stdin)['Account'])")
ASSUMED_ARN=$(echo "$CALLER" | python3 -c "import sys,json; print(json.load(sys.stdin)['Arn'])")

echo ""
echo "============================================"
echo "  WK AWS Connection Established"
echo "============================================"
echo "  Account:    $ASSUMED_ACCOUNT"
echo "  Role:       WKFedRoles-${ROLE_TYPE}"
echo "  ARN:        $ASSUMED_ARN"
echo "  Expires:    $EXPIRATION"
echo "  Region:     $WK_REGION (default)"
echo "============================================"
echo ""
echo "AWS CLI is now configured for account $ACCOUNT_NUMBER."
echo "Run any AWS command — credentials are exported as env vars."
