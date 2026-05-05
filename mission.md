# Mission

## Why this exists

A CloudOps SRE at Wolters Kluwer at 2am, paged by an alert, has to:

1. Open Confluence to find the runbook
2. Open Azure DevOps to check pipeline state
3. Open Slack to ask if a teammate has seen this
4. Open a terminal to ssh into the VM
5. Maybe open ChatGPT to ask "what does this error mean"
6. Maybe open the WK-GHCOS GitHub repo to read the underlying script
7. Eventually piece it together and act

This is six tabs and ~10 minutes of context-loading before the SRE has done anything useful. Every minute is downtime.

**CloudOps Workspace replaces six tabs with one.** Chat with pi (a local agent) that has read-only Confluence search, knows your runbooks, can run remote commands, and — uniquely — **saves what it learns as permanent skills** so the next on-call never has to look the same thing up twice.

## Target user

**The hero user is the on-call SRE at 2am.** Tertiary users (engineering managers, new hires, platform team) are real but not the design center. If a feature helps the EM but slows the SRE, the SRE wins.

| User | When they care | Primary need |
|---|---|---|
| **On-call SRE (hero)** | Paged at 2am | Fix the alert without alt-tabbing through 6 systems |
| New CloudOps hire | Day 1 onboarding | Day-1 self-serve: "what is COBRA? how do we patch?" |
| Engineering manager | Weekly review | "How much was on-fire last week? What runbooks are missing?" |
| Platform team (GBS-IPM-DXG) | When pi-workspace is mature | Graduate proven skills to Cobra MCP servers |

## What makes this different from existing options

| Option | Why it's not enough |
|---|---|
| **Cobra (the WK platform)** | Hosted; gated by Coupa/Orca/ATP-demo onboarding. Too heavy for ad-hoc SRE work. We complement Cobra, not replace it: pi-workspace is the prototyping fast-lane that graduates capabilities into Cobra. |
| **ChatGPT + Confluence search** | No tool execution; can't run anything. Each session forgets everything. No team knowledge accumulation. |
| **Bare pi CLI** | Works, but the SRE wants chat + graph + terminal in one window, not a TUI plus four other tabs. |
| **`hermes-workspace`** | Runs `hermes-agent`, not pi. Right shape, wrong runtime. We borrow the UX, swap the agent. |

## The defining feature: knowledge that compounds

**Every time the AI looks something up in Confluence, the SRE can say "save that as a skill."** The AI writes a markdown file to `.pi/skills/`, the file watcher fires, the knowledge graph animates a new node. The next person — or the same SRE next month — gets the answer instantly without burning a Confluence call.

This is the only feature in the demo without an obvious off-the-shelf substitute. It's also the riskiest to build. Hence five spikes before the spec was locked.

## Definition of done

A new SRE clones the repo, runs `bash start.sh`, opens the browser, and successfully completes the 7-step demo (KB hit → KB miss → Confluence fallback → save as skill → graph updates → KB hit on re-ask) in under 5 minutes, end-to-end, on the live VM.

## Anti-mission (what this is NOT)

- **NOT a replacement for Cobra.** Cobra is sanctioned, hosted, governed. This is local, fast-loop, prototyping.
- **NOT multi-user / multi-tenant.** Single-user local-first. Tailscale gives "remote access from my phone," not real multi-tenancy.
- **NOT a chat product.** Chat is the surface; the agent loop, the KB, and the skills are the actual product.
- **NOT auto-publishing.** The agent never writes to Confluence, never opens PRs, never deploys. Read-only by default; mutations gated by explicit user request and the existing pi tool guards.
- **NOT a workflow engine in Phase 1.** The MVP intentionally scopes the verb "create" to mean "create skills" (single runbooks). The original product intent — *"main agent creates sub-agents to create workflows"* — is preserved as a **committed Phase 2 deliverable** (`add-workflow-engine`, see `roadmap.md`). The skill-creation flow in Stage 6 demonstrates the architectural seam that will host workflows. Keeping Phase 1 narrow lets the demo ship in ~22h; Phase 2 builds on the working spine, not a parallel track.
