---
name: disk-cleanup
description: Reclaim disk space on a VM with safe defaults. Wraps WK-GHCOS/AutoDataDiskCleanUp.
tags: [maintenance, sre]
---

# disk-cleanup

Reclaims disk space on a VM by clearing well-known caches and rotated logs. Default mode is dry-run.

## What gets cleaned

- `/var/cache/apt/archives/*.deb` (Debian) or `/var/cache/yum/` (RHEL)
- `/var/log/*.gz`, `/var/log/*.1` (rotated logs older than 7 days)
- `/tmp/*` (older than 24h)
- Orphan kernel images (Debian: `apt autoremove --purge`)

## What is NOT touched

- Running databases, container volumes, anything under `/srv`, `/opt`, or `/data`.
- Log files that aren't rotated yet.

## Modes

- `dry-run` (default): print what would be removed.
- `apply`: actually remove. Requires explicit confirmation.

The skill is intentionally conservative; for deeper cleanup, use the targeted runbook for the specific tenant.
