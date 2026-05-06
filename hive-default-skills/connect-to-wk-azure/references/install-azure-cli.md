# Install Azure CLI

The skill `connect-to-wk-azure` requires the `az` binary on `$PATH`. If
`command -v az` returns nothing, install with one of the snippets below.
All snippets are non-interactive and idempotent.

## Detect the host

```bash
if [ "$(uname -s)" = "Darwin" ]; then OS=macos
elif [ -f /etc/debian_version ]; then OS=debian
elif [ -f /etc/redhat-release ] || [ -f /etc/system-release ]; then OS=rhel
else OS=unknown; fi
echo "$OS"
```

## macOS (Homebrew)

```bash
brew update && brew install azure-cli
```

## Linux — Debian / Ubuntu

Microsoft's one-liner installer (signed apt repo + package install):

```bash
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
```

If you prefer manual steps (no piped curl into sudo):

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl apt-transport-https lsb-release gnupg
sudo mkdir -p /etc/apt/keyrings
curl -sLS https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor | \
  sudo tee /etc/apt/keyrings/microsoft.gpg > /dev/null
sudo chmod go+r /etc/apt/keyrings/microsoft.gpg
AZ_REPO=$(lsb_release -cs)
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] \
  https://packages.microsoft.com/repos/azure-cli/ $AZ_REPO main" | \
  sudo tee /etc/apt/sources.list.d/azure-cli.list
sudo apt-get update && sudo apt-get install -y azure-cli
```

## Linux — RHEL / Amazon Linux 2 / CentOS

```bash
sudo rpm --import https://packages.microsoft.com/keys/microsoft.asc
sudo dnf install -y https://packages.microsoft.com/config/rhel/9/packages-microsoft-prod.rpm 2>/dev/null || \
sudo yum install -y https://packages.microsoft.com/config/rhel/9/packages-microsoft-prod.rpm
sudo dnf install -y azure-cli || sudo yum install -y azure-cli
```

## Verify

```bash
az --version     # expect: azure-cli 2.x.x
which az         # expect: /usr/bin/az or /opt/homebrew/bin/az
```

## After install

The skill expects:
- `~/.azure/.env` populated with `ARM_CLIENT_ID`, `ARM_CLIENT_SECRET`,
  `ARM_TENANT_ID`. The Hive secret store can supply these via the `azure.*`
  secret prefix.
- `python3` available (used for JSON parsing in the helper script).

If `az login --service-principal` returns `AADSTS*` errors, see
`azure-sp-auth.md` for tenant / secret troubleshooting.
