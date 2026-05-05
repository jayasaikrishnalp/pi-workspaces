---
name: check-server-health
description: Read-only triage of a target VM. Checks load average, disk usage, key services, and recent kernel errors. Safe to run anywhere.
tags: [readonly, triage, sre]
---

# check-server-health

Use this skill before doing anything destructive on a VM. It produces a one-screen summary of:

- 1/5/15 minute load averages
- `df -h` for `/`, `/var`, `/tmp`
- `systemctl --failed`
- Last 50 lines of `journalctl -p err`
- Network: default route + DNS resolution sanity check

## When to use

- A VM was reported as "slow" or "broken" but it's not yet clear how.
- Before [[reboot-server]] or [[patch-vm]], to confirm the VM is genuinely healthy enough to perform the destructive operation.
- After a deploy, to confirm services came back up.

## Output

Plain text, sectioned, copy-pasteable into an incident summary. Nothing is mutated.
