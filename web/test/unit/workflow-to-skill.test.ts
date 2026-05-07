import { describe, it, expect } from 'vitest'

import {
  workflowSkillName, workflowSkillDescription, workflowToSkillMd,
} from '../../src/lib/workflow-to-skill'
import { DEFAULT_WORKFLOWS, parseWorkflowYaml } from '../../src/lib/workflows-store'
import { DEFAULT_AGENT_ROSTER } from '../../src/lib/agents-store'

describe('workflowSkillName', () => {
  it("strips 'wf-' prefix and produces a kebab-case skill name", () => {
    expect(workflowSkillName({ id: 'wf-l1-ritm-fetch' } as never)).toBe('l1-ritm-fetch')
    expect(workflowSkillName({ id: 'wf-server-deletion' } as never)).toBe('server-deletion')
  })
  it('lowercases and replaces invalid chars', () => {
    expect(workflowSkillName({ id: 'My Workflow!' } as never)).toBe('my-workflow')
  })
  it('forces leading letter when starting with a digit', () => {
    expect(workflowSkillName({ id: '123-foo' } as never)).toBe('wf-123-foo')
  })
  it('produces a name accepted by the server regex /^[a-z][a-z0-9-]{0,63}$/', () => {
    const SERVER_RE = /^[a-z][a-z0-9-]{0,63}$/
    for (const wf of DEFAULT_WORKFLOWS) {
      expect(SERVER_RE.test(workflowSkillName(wf))).toBe(true)
    }
  })
})

describe('workflowSkillDescription', () => {
  it('mentions the workflow name and inputs', () => {
    const wf = DEFAULT_WORKFLOWS.find((w) => w.id === 'wf-l1-ritm-fetch')!
    const desc = workflowSkillDescription(wf)
    expect(desc).toMatch(/L1 Triage/)
    expect(desc).toMatch(/prompt/)
  })
})

describe('workflowToSkillMd', () => {
  it('produces a SKILL.md body with Inputs / Outputs / Agents / YAML sections', () => {
    const wf = DEFAULT_WORKFLOWS.find((w) => w.id === 'wf-l1-ritm-fetch')!
    const md = workflowToSkillMd(wf, DEFAULT_AGENT_ROSTER)
    expect(md).toContain('## Inputs (workflow contract)')
    expect(md).toContain('## Outputs')
    expect(md).toContain('## Agents in the chain')
    expect(md).toContain('## How to invoke')
    expect(md).toContain('## Embedded workflow definition (hive.workflow/v1 YAML)')
    // Lists the typed input
    expect(md).toMatch(/- \*\*prompt\*\* \(`text`\)/)
    // Lists at least one declared output
    expect(md).toMatch(/- \*\*summary\*\* \(`markdown`\)/)
    // Embeds the YAML — should round-trip back to the workflow
    const yamlBlock = md.split('```yaml')[1]?.split('```')[0]?.trim()
    expect(yamlBlock).toBeTruthy()
    const parsed = parseWorkflowYaml(yamlBlock!, DEFAULT_AGENT_ROSTER, new Set())
    expect(parsed.workflow.id).toBe(wf.id)
    expect(parsed.workflow.steps.length).toBe(wf.steps.length)
    expect(parsed.workflow.bindings?.length).toBe(wf.bindings?.length)
  })

  it('handles workflows without inputs/outputs/bindings gracefully', () => {
    const minimal = {
      id: 'wf-min', name: 'Min', task: '', createdAt: 'x',
      steps: [{ id: 'a', agentId: 'jira-agent', note: '' }],
    }
    const md = workflowToSkillMd(minimal as never, DEFAULT_AGENT_ROSTER)
    expect(md).toContain('_None — this workflow has no external inputs._')
    expect(md).toContain('_None declared._')
  })
})
