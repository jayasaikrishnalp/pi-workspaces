import { describe, it, expect } from 'vitest'

import {
  workflowToYaml, parseWorkflowYaml, stubAgent,
  type Workflow,
} from '../../src/lib/workflows-store'
import { DEFAULT_AGENT_ROSTER, type Agent } from '../../src/lib/agents-store'

const sample: Workflow = {
  id: 'wf-test',
  name: 'Test workflow',
  task: 'demo',
  createdAt: '2026-05-07T00:00:00Z',
  steps: [
    { id: 'first',  agentId: 'jira-agent', note: 'pull ticket' },
    { id: 'second', agentId: 'coding-agent', note: 'implement', branches: { ok: 'third', err: 'end' } },
    { id: 'third',  agentId: 'deploy-agent', note: 'ship' },
  ],
}

describe('workflowToYaml + parseWorkflowYaml', () => {
  it('round-trips a workflow through YAML preserving id/name/task/steps/branches', () => {
    const yaml = workflowToYaml(sample, DEFAULT_AGENT_ROSTER)
    expect(yaml).toContain('schema: hive.workflow/v1')
    expect(yaml).toContain('id: wf-test')
    const parsed = parseWorkflowYaml(yaml, DEFAULT_AGENT_ROSTER, new Set())
    expect(parsed.workflow.id).toBe('wf-test')
    expect(parsed.workflow.steps).toHaveLength(3)
    expect(parsed.workflow.steps[1]?.branches).toEqual({ ok: 'third', err: 'end' })
    expect(parsed.missingAgentIds).toEqual([])
  })

  it('inlines only the agents referenced by steps, not the entire roster', () => {
    const yaml = workflowToYaml(sample, DEFAULT_AGENT_ROSTER)
    // Re-parse and count: 3 agents inlined, 5 unreferenced ones omitted.
    const reparsed = parseWorkflowYaml(yaml, [], new Set())
    expect(reparsed.inlinedAgents.map((a) => a.id).sort()).toEqual(
      ['coding-agent', 'deploy-agent', 'jira-agent'],
    )
    expect(yaml).not.toContain('id: l1-triage-agent')
  })

  it('surfaces missing agent ids when YAML refs an agent not in roster and not inlined', () => {
    const yaml = `schema: hive.workflow/v1
id: wf-x
name: X
task: y
flow:
  - agent: jira-agent
  - agent: ghost-agent
  - agent: deploy-agent
`
    const parsed = parseWorkflowYaml(yaml, DEFAULT_AGENT_ROSTER, new Set())
    expect(parsed.missingAgentIds).toEqual(['ghost-agent'])
  })

  it('inlined agents in YAML satisfy missing-agent reconciliation', () => {
    const yaml = `schema: hive.workflow/v1
id: wf-x
name: X
task: y
agents:
  - id: ghost-agent
    name: Ghost
    kind: specialist
    model: claude-haiku-4-5
    skills: [some.skill]
    prompt: hi
flow:
  - agent: ghost-agent
`
    const parsed = parseWorkflowYaml(yaml, DEFAULT_AGENT_ROSTER, new Set())
    expect(parsed.missingAgentIds).toEqual([])
    expect(parsed.inlinedAgents).toHaveLength(1)
    expect(parsed.inlinedAgents[0]?.id).toBe('ghost-agent')
  })

  it('surfaces missing skills referenced by inlined agents but not in the known set', () => {
    const yaml = `schema: hive.workflow/v1
id: wf-x
name: X
task: y
agents:
  - id: ghost-agent
    name: Ghost
    kind: specialist
    model: claude-haiku-4-5
    skills: [skill.exists, skill.missing-1, skill.missing-2]
    prompt: hi
flow:
  - agent: ghost-agent
`
    const parsed = parseWorkflowYaml(yaml, DEFAULT_AGENT_ROSTER, new Set(['skill.exists']))
    expect(parsed.missingSkills.sort()).toEqual(['skill.missing-1', 'skill.missing-2'])
  })

  it('rejects a YAML with the wrong schema', () => {
    const bad = 'schema: foo/v1\nid: x\nname: y\nflow: []\n'
    expect(() => parseWorkflowYaml(bad, [], new Set())).toThrow(/schema/)
  })

  it('rejects empty flow', () => {
    const bad = 'schema: hive.workflow/v1\nid: x\nname: y\ntask: t\nflow: []\n'
    expect(() => parseWorkflowYaml(bad, [], new Set())).toThrow(/flow/)
  })

  it('auto-generates step ids when YAML omits them', () => {
    const yaml = `schema: hive.workflow/v1
id: wf-x
name: X
task: y
flow:
  - agent: jira-agent
  - agent: deploy-agent
`
    const parsed = parseWorkflowYaml(yaml, DEFAULT_AGENT_ROSTER, new Set())
    expect(parsed.workflow.steps.map((s) => s.id)).toEqual(['step-1', 'step-2'])
  })
})

describe('typed I/O contracts round-trip', () => {
  it('preserves workflow inputs/outputs and bindings through YAML', () => {
    const wf = {
      id: 'wf-typed', name: 'Typed', task: 'demo', createdAt: 'x',
      inputs: [{ name: 'host', type: 'hostname', required: true, desc: 'Target' }],
      outputs: [{ name: 'status', type: 'enum<ok|fail>' }],
      steps: [
        { id: 'triage', agentId: 'l1-triage-agent', note: 'check' },
      ],
      bindings: [
        { to: 'triage.host', from: { kind: 'workflow' as const, field: 'host' } },
        { to: 'triage.request_type', from: { kind: 'workflow' as const, field: 'host' } },
        { to: 'out.status', from: { kind: 'step' as const, stepId: 'triage', field: 'policy_pass' } },
      ],
    }
    const yaml = workflowToYaml(wf, DEFAULT_AGENT_ROSTER)
    expect(yaml).toContain('inputs:')
    expect(yaml).toContain('outputs:')
    expect(yaml).toContain('bindings:')
    expect(yaml).toMatch(/from: workflow\.host/)
    expect(yaml).toMatch(/from: triage\.policy_pass/)
    const parsed = parseWorkflowYaml(yaml, DEFAULT_AGENT_ROSTER, new Set())
    expect(parsed.workflow.inputs?.[0]?.name).toBe('host')
    expect(parsed.workflow.outputs?.[0]?.type).toBe('enum<ok|fail>')
    expect(parsed.workflow.bindings).toHaveLength(3)
    expect(parsed.workflow.bindings![0]?.from).toEqual({ kind: 'workflow', field: 'host' })
    expect(parsed.workflow.bindings![2]?.from).toEqual({ kind: 'step', stepId: 'triage', field: 'policy_pass' })
  })

  it('preserves agent inputs/outputs through YAML inline-agent serialization', () => {
    const wf = {
      id: 'wf-x', name: 'x', task: '', createdAt: 'x',
      steps: [{ id: 'j', agentId: 'jira-agent' }],
    }
    const yaml = workflowToYaml(wf as never, DEFAULT_AGENT_ROSTER)
    // jira-agent has typed I/O — they should round-trip
    expect(yaml).toMatch(/name: ticket_key/)
    expect(yaml).toMatch(/name: acceptance/)
    const parsed = parseWorkflowYaml(yaml, [], new Set())
    const jira = parsed.inlinedAgents.find((a) => a.id === 'jira-agent')
    expect(jira?.inputs?.[0]?.name).toBe('ticket_key')
    expect(jira?.outputs?.find((o) => o.name === 'ticket_url')?.type).toBe('url')
  })
})

describe('stubAgent', () => {
  it('produces a kebab→Title cased name and specialist kind', () => {
    const a: Agent = stubAgent('my-cool-agent')
    expect(a.id).toBe('my-cool-agent')
    expect(a.name).toBe('My Cool Agent')
    expect(a.kind).toBe('specialist')
    expect(a.skills).toEqual([])
    expect(a.prompt).toContain('my-cool-agent')
  })
})
