/**
 * Convert a Hive workflow into a SKILL.md body that pi can load and use.
 *
 * The generated skill teaches pi how to invoke the workflow as if it were
 * a single high-level capability — given the workflow's typed inputs, run
 * the agent chain and produce the typed outputs. The full hive.workflow/v1
 * YAML is embedded verbatim so the implementing pi can read the exact
 * step graph + bindings.
 */

import type { Workflow } from './workflows-store'
import type { Agent } from './agents-store'
import { workflowToYaml } from './workflows-store'

/** Sanitize a workflow id into a kebab-case skill name accepted by /api/skills.
 *  Removes any non-[a-z0-9-] chars and ensures a leading letter. */
export function workflowSkillName(workflow: Workflow): string {
  // Strip the conventional 'wf-' prefix so e.g. 'wf-cloudops-dashboard' →
  // 'cloudops-dashboard'. Keep the rest verbatim if it's already valid.
  const stripped = workflow.id.replace(/^wf-/, '')
  // Lowercase, replace anything not a-z/0-9 with -
  let name = stripped.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  // Force leading letter (server regex: ^[a-z][a-z0-9-]{0,63}$)
  if (!/^[a-z]/.test(name)) name = `wf-${name}`
  if (name.length === 0) name = 'unnamed-workflow'
  if (name.length > 64) name = name.slice(0, 64).replace(/-+$/, '')
  return name
}

/**
 * Build a SKILL.md frontmatter description from the workflow. Lean
 * slightly pushy on triggers so pi doesn't under-trigger.
 */
export function workflowSkillDescription(workflow: Workflow): string {
  const inputs = (workflow.inputs ?? []).map((i) => i.name).join(', ')
  const trigger = workflow.task ? workflow.task.split(/[.!?]/)[0] : workflow.name
  return [
    `Run the "${workflow.name}" workflow.`,
    inputs ? `Inputs: ${inputs}.` : null,
    `Use whenever the user asks to ${trigger.toLowerCase()}, references this workflow by name, or wants to kick off the chain even informally.`,
  ].filter(Boolean).join(' ')
}

/** Generate the full SKILL.md body for a workflow. */
export function workflowToSkillMd(workflow: Workflow, roster: Agent[]): string {
  const inputs = workflow.inputs ?? []
  const outputs = workflow.outputs ?? []
  const yaml = workflowToYaml(workflow, roster)

  const inputsSection = inputs.length > 0
    ? inputs.map((f) => `- **${f.name}** (\`${f.type}\`)${f.required ? ' — required' : ''}${f.desc ? ` — ${f.desc}` : ''}`).join('\n')
    : '_None — this workflow has no external inputs._'

  const outputsSection = outputs.length > 0
    ? outputs.map((f) => `- **${f.name}** (\`${f.type}\`)${f.desc ? ` — ${f.desc}` : ''}`).join('\n')
    : '_None declared._'

  // Build a compact list of agents involved.
  const usedIds = new Set(workflow.steps.map((s) => s.agentId))
  const usedAgents = roster.filter((a) => usedIds.has(a.id))
  const agentList = usedAgents.length > 0
    ? usedAgents.map((a) => `- **${a.name}** (\`${a.id}\`, ${a.kind}) — ${a.role || a.prompt.split('\n')[0]?.slice(0, 80) || ''}`).join('\n')
    : '_No agents resolved from the current roster._'

  return `# ${workflow.name}

${workflow.task || `Hive workflow exported as a skill on ${new Date().toISOString().slice(0, 10)}.`}

## When to trigger

- The user mentions "${workflow.name}" by name
- The user asks for any of the inputs (${inputs.map((i) => `\`${i.name}\``).join(', ') || '—'}) or expects any of the outputs (${outputs.map((o) => `\`${o.name}\``).join(', ') || '—'})
- The user describes the same outcome in their own words

## Inputs (workflow contract)

${inputsSection}

## Outputs

${outputsSection}

## Agents in the chain

${agentList}

## How to invoke

The workflow runs server-side. Post to \`/api/workflow-runs\` with the
workflow definition + the agent roster, then watch the SSE event stream
for run progress.

\`\`\`bash
TOKEN="\${WORKSPACE_INTERNAL_TOKEN:?missing}"
PORT="\$(cat ~/.pi-workspace/server.port 2>/dev/null || echo 8766)"

# 1. Resolve the workflow definition (this skill embeds it; you can also
#    POST a JSON object that mirrors the YAML below). The server expects:
#    { workflow: <Workflow>, agents: [<Agent>, ...] }

# 2. Start the run
curl -sS -X POST \\
  -H 'Content-Type: application/json' \\
  -H "x-workspace-internal-token: \$TOKEN" \\
  -d "@workflow-payload.json" \\
  "http://127.0.0.1:\${PORT}/api/workflow-runs"
# → 202 { runId }

# 3. Stream events
curl -sS -N \\
  -H "x-workspace-internal-token: \$TOKEN" \\
  "http://127.0.0.1:\${PORT}/api/workflow-runs/\${runId}/events"
\`\`\`

## Embedded workflow definition (hive.workflow/v1 YAML)

This is the canonical, typed representation of the chain — agents, steps,
\`branches\` for decision routing, and \`bindings\` for pin-to-pin wiring
between step inputs/outputs and the workflow contract.

\`\`\`yaml
${yaml.trimEnd()}
\`\`\`

## Anti-patterns

- Don't re-invent the wiring inline. The \`bindings\` block above is the
  single source of truth for "how does \`X.input\` get its value?".
- Don't skip the agent roster on the POST — the server validates that
  every \`steps[].agentId\` resolves.
- Don't poll the run endpoint in a tight loop. Subscribe to SSE and
  drive off events.

---

_Auto-generated from workflow \`${workflow.id}\` by the Hive
"Save as Skill" action. Re-run the action to refresh after editing the
workflow._
`
}
