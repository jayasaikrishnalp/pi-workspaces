/**
 * Server-side definitions of the auto-review workflow + agent.
 *
 * These are NOT user-editable through the Workflows UI — the review system
 * spawns runs of REVIEW_WORKFLOW automatically after every user-triggered
 * run completes. The agent's only job is to decide whether the parent run's
 * transcript is worth saving as a skill or memory entry, then call
 * `mcp__hive-self__skill_*` / `mcp__hive-self__memory_*` to persist it.
 *
 * Recursion guard: every call site that spawns review runs MUST check
 * `parentInfo.workflowId === REVIEW_WORKFLOW_ID` and skip — otherwise a
 * review's own completion would trigger another review, ad infinitum.
 */

import type { Workflow, AgentDef } from './workflow-runner.js'

/** Reserved id. The review-runner uses this constant in its own
 *  recursion guard; do not change without updating the guard. */
export const REVIEW_WORKFLOW_ID = 'wf-auto-skill-review'

/** Reserved id used as a second belt-and-suspenders guard. */
export const REVIEW_TRIGGERED_BY = 'auto-review'

export const REVIEW_AGENT: AgentDef = {
  id: 'l1-review-agent',
  name: 'L1 Review Agent',
  kind: 'reviewer',
  role: 'Reviews completed workflow runs and decides whether to save reusable approaches as skills or durable facts as memory.',
  model: 'claude-haiku-4-5',
  skills: [],
  prompt:
    'You are the L1 Review Agent. A workflow run just completed and you have the transcript in your WORKFLOW INPUTS. Your only job is to decide: did the agents do something non-trivial that should be saved for next time?\n\n' +
    'You have these tools (via the MCP bridge):\n' +
    '  - mcp__hive-self__skill_list   — list every existing skill in the workspace\n' +
    '  - mcp__hive-self__skill_read   — read a SKILL.md (use BEFORE editing!)\n' +
    '  - mcp__hive-self__skill_create — create a brand-new skill\n' +
    '  - mcp__hive-self__skill_patch  — surgical find-and-replace inside a skill (preferred for updates)\n' +
    '  - mcp__hive-self__skill_edit   — full body rewrite of a skill (last resort)\n' +
    '  - mcp__hive-self__memory_list  — list memory entries\n' +
    '  - mcp__hive-self__memory_read  — read a memory entry\n' +
    '  - mcp__hive-self__memory_write — upsert a memory entry (server runs threat scan)\n\n' +
    'Decision criteria:\n' +
    '- **Save as skill** if a non-trivial reusable approach was discovered (multi-step, error recovery, branching logic, novel sequencing). Use `skill_list` first to see what already exists. If a related skill exists, prefer `skill_patch` to refine it; otherwise `skill_create`. Skill name: kebab-case (^[a-z][a-z0-9-]{0,63}$). Body: a compact SKILL.md with frontmatter `description` (one punchy sentence + 2-3 trigger phrases), `## When to use`, `## How to do it`, `## Anti-patterns`.\n' +
    '- **Save as memory** if a durable preference / project decision was expressed. Reserved memory names: `user` (for user preferences) and `project` (for workspace-level facts). Use `memory_read` to fetch the current entry first; APPEND to it (don\'t clobber).\n' +
    '- **Both** are allowed if both criteria fire.\n' +
    '- **Otherwise**: do nothing. Output decision=`no-op`.\n\n' +
    'Strict criteria (be conservative — false positives pollute the catalog):\n' +
    '  • Skip when the run was a one-shot lookup, info question, or dry-run with no decisions\n' +
    '  • Skip when the run failed early without producing actionable output\n' +
    '  • Skip when the discovered approach is already documented in an existing skill (verify with skill_list + skill_read)\n\n' +
    'You MUST end your response with a single line in this exact format:\n' +
    '  DECISION: <token>\n' +
    'where <token> is one of: saved-skill | updated-skill | saved-memory | no-op\n\n' +
    'Above the DECISION line, output a markdown summary describing what (if anything) you saved and why. Keep it terse — the operator will skim, not read.',
}
// Inputs/outputs declared informally — the runner's AgentDef shape doesn't
// include typed I/O (that's a frontend-only decoration). The review agent
// receives parent_run_id / parent_workflow_id / parent_workflow_name /
// transcript via composePrompt's WORKFLOW INPUTS section.

export const REVIEW_WORKFLOW: Workflow = {
  id: REVIEW_WORKFLOW_ID,
  name: 'Auto Skill Review (background)',
  task:
    'Internal: review the just-completed parent workflow run for reusable skills or durable facts. ' +
    'Spawned automatically by the workspace; not user-editable. Triggered by `triggeredBy=auto-review`.',
  steps: [
    {
      id: 'review',
      agentId: REVIEW_AGENT.id,
      note:
        'Read WORKFLOW INPUTS for parent_run_id, parent_workflow_name, and transcript. ' +
        'Inspect the transcript. Decide whether anything is worth saving as a skill or memory. ' +
        'Use the mcp__hive-self__* tools to persist. End with DECISION: <saved-skill|updated-skill|saved-memory|no-op>.',
      next: 'end',
    },
  ],
}
