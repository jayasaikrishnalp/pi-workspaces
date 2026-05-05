---
name: reboot-server
description: Reboot a VM with safety preflight. Wraps WK-GHCOS/AutoServerReboot. Asks for confirmation before issuing the reboot.
tags: [destructive, sre]
uses:
  - check-server-health
---

# reboot-server

Reboots a target VM, with a [[check-server-health]] preflight. Asks for explicit confirmation; does not auto-reboot.

## Preflight

1. Run [[check-server-health]] against the target.
2. If load averages are >5 across all CPUs and `iostat` shows pinned disk IO, abort and surface the diagnostic — the VM is doing real work.
3. Confirm with the operator: "Reboot {host}? (y/N)".

## Reboot

`sudo systemctl reboot` after a 10-second drain window. Logs the timestamp + initiator to `/var/log/wk-cloudops/reboots.log`.

## Postflight

- Wait up to 5 minutes for SSH to come back.
- Re-run [[check-server-health]].
- If anything is failing, page the on-call.
