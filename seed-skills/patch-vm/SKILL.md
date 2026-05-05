---
name: patch-vm
description: Apply OS patches with prechecks. Wraps WK-GHCOS/PrePatchingAutomation. Idempotent.
tags: [destructive, patching, sre]
uses:
  - check-server-health
  - disk-cleanup
---

# patch-vm

Apply pending OS patches to a VM via the WK pre-patching automation, with safety prechecks borrowed from [[check-server-health]] and [[disk-cleanup]].

## Prechecks

1. [[check-server-health]] must pass — no failed services, no disk >90%.
2. [[disk-cleanup]] is run if `/var` is >70% to ensure the patch staging area has room.
3. The VM's `wk_patch_class` tag must be set; if missing, surface the diagnostic and abort with a pointer to the runbook.

## Apply

- `apt-get update && apt-get upgrade -y` (Debian/Ubuntu)
- or `yum update -y` (RHEL/OEL)
- followed by a kernel-needed `[[reboot-server]]` if `needs-restarting -r` returns non-zero.

## Postflight

Run [[check-server-health]] again. Compare to baseline.
