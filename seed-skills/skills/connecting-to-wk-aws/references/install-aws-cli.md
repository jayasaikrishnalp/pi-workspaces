# Install AWS CLI v2

The skill `connecting-to-wk-aws` requires the AWS CLI v2 binary on `$PATH`. If
`command -v aws` returns nothing, install with one of the snippets below.
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
brew install awscli
```

If Homebrew isn't present, fall back to the official pkg installer:

```bash
curl -fsSL "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o /tmp/AWSCLIV2.pkg && \
  sudo installer -pkg /tmp/AWSCLIV2.pkg -target /
```

## Linux — Debian / Ubuntu

```bash
sudo apt-get update && sudo apt-get install -y curl unzip
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q -o /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install --update
rm -rf /tmp/aws /tmp/awscliv2.zip
```

For ARM64 hosts replace the URL with `awscli-exe-linux-aarch64.zip`.

## Linux — RHEL / Amazon Linux 2 / CentOS

Amazon Linux 2 and 2023 ship `aws` v1 in the default repo. To get v2:

```bash
sudo yum install -y unzip curl
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q -o /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install --update
rm -rf /tmp/aws /tmp/awscliv2.zip
```

## Verify

```bash
aws --version    # expect: aws-cli/2.x.x ...
which aws        # expect: /usr/local/bin/aws or /opt/homebrew/bin/aws
```

## After install

The skill expects:
- `~/.aws/credentials` to contain a `[WK-PROFILE]` section pointing at the
  master account (835377776149). The Hive secret store can populate this via
  the `aws.*` secret prefix.
- `python3` available (used for JSON parsing in the helper script).

If `aws sts get-caller-identity` returns an error with valid credentials
present, see `aws-sts-auth.md` for STS-specific troubleshooting.
