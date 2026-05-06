#!/bin/bash
# ============================================================================
# WK Azure Service Principal Login Helper
# ============================================================================
# Usage:
#   source wk-azure-login.sh <SUBSCRIPTION_ID>
#
# Arguments:
#   SUBSCRIPTION_ID  - Azure subscription ID (UUID format)
#
# Examples:
#   source wk-azure-login.sh a1b2c3d4-e5f6-7890-abcd-ef1234567890
#
# Credentials are loaded from ~/.azure/.env
# After sourcing, az CLI commands will use the target subscription.
# ============================================================================

set -euo pipefail

# --- Step 0: Ensure Azure CLI is installed --------------------------------
# Idempotent: no-op when `az` is already on PATH. Full install matrix in
# references/install-azure-cli.md. Designed to be safe to re-source.
if ! command -v az >/dev/null 2>&1; then
    echo "[wk-azure] Azure CLI not found — installing..."
    if [[ "$(uname -s)" == "Darwin" ]]; then
        if command -v brew >/dev/null 2>&1; then
            brew update && brew install azure-cli
        else
            echo "ERROR: Homebrew not found on macOS — install brew, then re-run."
            return 1 2>/dev/null || exit 1
        fi
    elif [[ -f /etc/debian_version ]]; then
        curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
    elif [[ -f /etc/redhat-release || -f /etc/system-release ]]; then
        sudo rpm --import https://packages.microsoft.com/keys/microsoft.asc
        if command -v dnf >/dev/null 2>&1; then
            sudo dnf install -y https://packages.microsoft.com/config/rhel/9/packages-microsoft-prod.rpm
            sudo dnf install -y azure-cli
        else
            sudo yum install -y https://packages.microsoft.com/config/rhel/9/packages-microsoft-prod.rpm
            sudo yum install -y azure-cli
        fi
    else
        echo "ERROR: unsupported OS — see references/install-azure-cli.md"
        return 1 2>/dev/null || exit 1
    fi
fi

# --- Step 0.5: Resolve service principal credentials ----------------------
# Prefer env vars (Hive Secret Store path). Fall back to ~/.azure/.env.
# Bail loudly when neither is available.
ENV_FILE="$HOME/.azure/.env"

if [[ -n "${ARM_CLIENT_ID:-}" && -n "${ARM_CLIENT_SECRET:-}" && -n "${ARM_TENANT_ID:-}" ]]; then
    echo "[wk-azure] using credentials from environment"
elif [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
    if [[ -z "${ARM_CLIENT_ID:-}" || -z "${ARM_CLIENT_SECRET:-}" || -z "${ARM_TENANT_ID:-}" ]]; then
        echo "ERROR: $ENV_FILE missing required ARM_CLIENT_ID, ARM_CLIENT_SECRET, ARM_TENANT_ID"
        return 1 2>/dev/null || exit 1
    fi
    echo "[wk-azure] using legacy credentials from $ENV_FILE"
else
    echo "ERROR: no Azure service principal credentials available."
    echo "  Set azure.client_id, azure.client_secret, azure.tenant_id in the Hive Secret Store,"
    echo "  or create $ENV_FILE with ARM_CLIENT_ID, ARM_CLIENT_SECRET, ARM_TENANT_ID."
    return 1 2>/dev/null || exit 1
fi

# --- Input Validation ---
SUBSCRIPTION_ID="${1:-}"

if [[ -z "$SUBSCRIPTION_ID" ]]; then
    echo "ERROR: Subscription ID is required."
    echo "Usage: source wk-azure-login.sh <SUBSCRIPTION_ID>"
    return 1 2>/dev/null || exit 1
fi

if [[ ! "$SUBSCRIPTION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    echo "ERROR: Subscription ID must be a valid UUID. Got: $SUBSCRIPTION_ID"
    return 1 2>/dev/null || exit 1
fi

# --- Step 1: Login with Service Principal ---
echo "Logging in with WK Service Principal..."

LOGIN_OUTPUT=$(az login --service-principal \
    -u "$ARM_CLIENT_ID" \
    -p "$ARM_CLIENT_SECRET" \
    --tenant "$ARM_TENANT_ID" \
    --output json 2>&1)

if [[ $? -ne 0 ]]; then
    echo "ERROR: Failed to login with service principal."
    echo "$LOGIN_OUTPUT"
    return 1 2>/dev/null || exit 1
fi

# --- Step 2: Set the target subscription ---
echo "Setting subscription to ${SUBSCRIPTION_ID}..."

az account set --subscription "$SUBSCRIPTION_ID" 2>&1
if [[ $? -ne 0 ]]; then
    echo "ERROR: Failed to set subscription. It may not be accessible with this service principal."
    echo ""
    echo "Available subscriptions:"
    az account list --query '[].{Name:name, Id:id, State:state}' --output table
    return 1 2>/dev/null || exit 1
fi

# --- Step 3: Export for Terraform compatibility ---
export ARM_CLIENT_ID
export ARM_CLIENT_SECRET
export ARM_TENANT_ID
export ARM_SUBSCRIPTION_ID="$SUBSCRIPTION_ID"

# --- Step 4: Verify ---
ACCOUNT_INFO=$(az account show --output json 2>/dev/null)
ACCOUNT_NAME=$(echo "$ACCOUNT_INFO" | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])")
ACCOUNT_ID=$(echo "$ACCOUNT_INFO" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
ACCOUNT_STATE=$(echo "$ACCOUNT_INFO" | python3 -c "import sys,json; print(json.load(sys.stdin)['state'])")

echo ""
echo "============================================"
echo "  WK Azure Connection Established"
echo "============================================"
echo "  Subscription:  $ACCOUNT_NAME"
echo "  ID:            $ACCOUNT_ID"
echo "  State:         $ACCOUNT_STATE"
echo "  Tenant:        $ARM_TENANT_ID"
echo "  Client:        $ARM_CLIENT_ID"
echo "============================================"
echo ""
echo "Azure CLI is now configured for subscription $SUBSCRIPTION_ID."
echo "Run any az command — credentials are active."
