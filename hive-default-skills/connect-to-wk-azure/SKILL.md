---
name: connect-to-wk-azure
description: Connect to any Wolter Kluwer (WK) Azure subscription using service principal credentials. Activate when the user says "connect to wk azure", "wk azure", "azure account", "azure subscription", or references any Azure subscription ID for operations. Also activates when user asks to perform any Azure operation (list VMs, create resources, check resources, etc.) on a WK Azure subscription.
---

# Connecting to WK Azure Subscriptions

This skill handles service principal authentication into any Wolter Kluwer (WK) Azure subscription using credentials stored in `~/.azure/.env`.

## Architecture

```
~/.azure/.env                        Target Azure Subscription
┌─────────────────────────┐          ┌──────────────────────────┐
│  ARM_CLIENT_ID           │          │                          │
│  ARM_CLIENT_SECRET       │──SP──►   │  Subscription Resources  │
│  ARM_TENANT_ID           │ login    │  (VMs, Storage, etc.)    │
│                          │          │                          │
└─────────────────────────┘          └──────────────────────────┘
```

## Configuration

- **Credential source (preferred)**: environment variables, populated by the
  **Hive Secret Store** under the `azure.*` prefix:
  - `azure.client_id` → `ARM_CLIENT_ID`
  - `azure.client_secret` → `ARM_CLIENT_SECRET`
  - `azure.tenant_id` → `ARM_TENANT_ID`
  - `azure.subscription_id` → `ARM_SUBSCRIPTION_ID` (default subscription)

  When these are present, both `az login --service-principal` and the
  Terraform `azurerm` provider read them directly. **No `~/.azure/.env`
  file required.**

- **Credential source (fallback)**: `~/.azure/.env` file with the same
  `ARM_*` variables. The skill sources it only when env vars aren't set.

- **Auth Method**: Service Principal (client ID + client secret)
- **Helper Script**: `templates/wk-azure-login.sh`
- **Reference Docs**: `references/azure-sp-auth.md`, `references/install-azure-cli.md`

## .env File Schema

| Variable | Description | Example |
|----------|-------------|---------|
| `ARM_CLIENT_ID` | Service Principal app/client ID | `00000000-0000-0000-0000-000000000000` |
| `ARM_CLIENT_SECRET` | Service Principal client secret | `<CLIENT_SECRET>` |
| `ARM_TENANT_ID` | Azure AD tenant ID | `00000000-0000-0000-0000-000000000000` |

> **Note:** The values above are placeholders. The operator provisions real
> values in `~/.azure/.env` out-of-band, or — once available — via the Hive
> secret store under the `azure.*` prefix.

## Connection Workflow

### Step 0: Ensure Azure CLI Is Installed

Before any other step, verify the `az` binary is on `$PATH`. Install it
non-interactively if missing. Full per-OS install matrix lives in
`references/install-azure-cli.md`.

```bash
if ! command -v az >/dev/null 2>&1; then
  echo "[wk-azure] Azure CLI not found — installing..."
  if [ "$(uname -s)" = "Darwin" ]; then
    brew update && brew install azure-cli
  elif [ -f /etc/debian_version ]; then
    curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
  elif [ -f /etc/redhat-release ] || [ -f /etc/system-release ]; then
    sudo rpm --import https://packages.microsoft.com/keys/microsoft.asc
    sudo dnf install -y https://packages.microsoft.com/config/rhel/9/packages-microsoft-prod.rpm 2>/dev/null \
      || sudo yum install -y https://packages.microsoft.com/config/rhel/9/packages-microsoft-prod.rpm
    sudo dnf install -y azure-cli || sudo yum install -y azure-cli
  else
    echo "[wk-azure] unsupported OS — see references/install-azure-cli.md"
    exit 1
  fi
fi
az --version
```

The helper script `templates/wk-azure-login.sh` runs this check at the top, so
sourcing it covers Step 0 automatically. Run Step 0 manually first only when
*not* using the helper script.

### Step 0.5: Verify Service Principal Credentials Are Available

Hive populates `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_TENANT_ID` from the
secret store automatically when those entries exist (`azure.client_id`,
`azure.client_secret`, `azure.tenant_id`). The skill checks env vars first
and only falls back to `~/.azure/.env` when they're missing.

```bash
if [ -n "${ARM_CLIENT_ID:-}" ] && [ -n "${ARM_CLIENT_SECRET:-}" ] && [ -n "${ARM_TENANT_ID:-}" ]; then
  echo "[wk-azure] using credentials from environment (Hive secret store)"
elif [ -f "$HOME/.azure/.env" ]; then
  set -a; source "$HOME/.azure/.env"; set +a
  if [ -z "${ARM_CLIENT_ID:-}" ] || [ -z "${ARM_CLIENT_SECRET:-}" ] || [ -z "${ARM_TENANT_ID:-}" ]; then
    echo "[wk-azure] ~/.azure/.env missing required ARM_* vars"
    exit 1
  fi
  echo "[wk-azure] using legacy credentials from ~/.azure/.env"
else
  echo "[wk-azure] no credentials available — set azure.client_id,"
  echo "[wk-azure] azure.client_secret, azure.tenant_id in the Hive Secret Store,"
  echo "[wk-azure] or create ~/.azure/.env with ARM_*. Cannot proceed."
  exit 1
fi
```

### Step 1: Login and Set Subscription (Single Bash Call)

**CRITICAL**: Like the WK AWS skill, the login and subsequent az commands MUST be in the **same single Bash invocation**. The `az login` session persists across Bash calls (unlike AWS STS env vars), but always combine login + first command to verify connectivity.

```bash
source ~/.claude/skills/connect-to-wk-azure/templates/wk-azure-login.sh <SUBSCRIPTION_ID>
```

### Step 2: Execute Azure Commands

After sourcing the login script, run az commands in the same Bash call:

```bash
source ~/.claude/skills/connect-to-wk-azure/templates/wk-azure-login.sh <SUBSCRIPTION_ID> && \
az vm list --output table
```

### Manual Alternative (Without Script)

```bash
# ARM_* are already in the env when Hive populated them from the secret
# store. Run Step 0.5 first if running this turn cold.
az login --service-principal \
  -u "$ARM_CLIENT_ID" \
  -p "$ARM_CLIENT_SECRET" \
  --tenant "$ARM_TENANT_ID" \
  --output json && \
az account set --subscription "<SUBSCRIPTION_ID>" && \
az account show --output table
```

## Terraform Compatibility

The login script exports `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`, `ARM_TENANT_ID`, and `ARM_SUBSCRIPTION_ID` as environment variables. Terraform's `azurerm` provider picks these up automatically.

```bash
source ~/.claude/skills/connect-to-wk-azure/templates/wk-azure-login.sh <SUBSCRIPTION_ID> && \
terraform plan
```

## Trigger Phrases

Activate this skill when the user says any of:
- "connect to wk azure" / "wk azure" / "wolter kluwer azure"
- "connect to azure subscription {id}"
- "list VMs in azure subscription {id}"
- "check {resource} in azure {subscription_id}"
- Any Azure operation referencing a subscription ID
- "switch to azure subscription {id}"
- "az login" / "azure login"

## Common Operations After Connection

```bash
# List all VMs
az vm list --output table

# List resource groups
az group list --output table

# List all resources in a resource group
az resource list --resource-group <RG_NAME> --output table

# Check VM status
az vm get-instance-view --name <VM_NAME> --resource-group <RG_NAME> --query 'instanceView.statuses[1]' --output table

# List storage accounts
az storage account list --output table

# List AKS clusters
az aks list --output table
```

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| `AADSTS7000215` | Client secret expired or invalid | Regenerate secret and update `~/.azure/.env` |
| `AADSTS700016` | Client ID not found in tenant | Verify `ARM_CLIENT_ID` and `ARM_TENANT_ID` in `.env` |
| `SubscriptionNotFound` | SP lacks access to subscription | Grant SP access in Azure portal or use correct subscription ID |
| `no credentials available` (Step 0.5) | Neither env vars nor `~/.azure/.env` | Set `azure.client_id`, `azure.client_secret`, `azure.tenant_id` in the Hive Secret Store, or create `~/.azure/.env` |
| `az: command not found` | Azure CLI not installed | Run **Step 0** above; details in `references/install-azure-cli.md` |

## Important Notes

1. **Credentials are in `~/.azure/.env`** — never hardcode them in commands.
2. **Combine login + commands in a single Bash call** for reliability.
3. **The service principal must have access** to the target subscription (Reader, Contributor, etc.).
4. **Token refresh is handled by az CLI** — unlike AWS STS, you don't need to re-login for each command within the same session.
5. **For Terraform**, the exported env vars (`ARM_*`) are automatically used by the `azurerm` provider.
