---
name: aws-cleanup
description: Sweep an AWS account for orphaned resources (unused EBS volumes, dangling EIPs, idle ENIs, lapsed snapshots). Wraps WK-GHCOS/AWS_Resources_Cleanup.
tags: [aws, cost, sre]
uses:
  - check-server-health
---

# aws-cleanup

Identify orphaned billable AWS resources and (with confirmation) delete them.

## What it looks for

- EBS volumes in `available` state for >7 days
- Elastic IPs not associated with a running instance
- ENIs in `available` state for >7 days
- Snapshots older than the account's retention policy
- Empty security groups not referenced by any resource

## Modes

- `dry-run` (default): list orphans only; nothing is deleted.
- `apply`: requires per-resource confirmation; logs every deletion to a structured audit file.

For a target host's health before suspecting AWS-side issues, run [[check-server-health]] first — the volume "looks orphaned" symptom is sometimes really an EBS attach failure.
