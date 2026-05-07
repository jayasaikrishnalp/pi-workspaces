/**
 * Workflows store — localStorage-backed list of saved pipelines.
 *
 * Source of truth is YAML. The in-memory `Workflow` is a structural mirror
 * we serialize to YAML on export and parse from YAML on upload.
 *
 * YAML schema (hive.workflow/v1):
 *
 *   schema: hive.workflow/v1
 *   id: wf-server-deletion
 *   name: Server Deletion Workflow
 *   task: |
 *     Multi-line task description...
 *   agents:                     # OPTIONAL — inline agent defs that get
 *     - id: l1-triage-agent     # auto-created in the roster on upload if
 *       name: L1 Triage Agent   # missing.
 *       kind: router
 *       model: claude-haiku-4-5
 *       skills: [cmdb.lookup-host, owner.resolve]
 *       prompt: You are the L1 Triage Agent…
 *   flow:
 *     - id: triage              # OPTIONAL stable step id (auto-generated
 *                               # if absent: step-1, step-2, …)
 *       agent: l1-triage-agent  # REQUIRED — agent id from roster
 *       note: Validate request  # OPTIONAL human-readable note
 *       next: file-chg          # OPTIONAL explicit next-step id; default
 *                               # is the next step in the list. Special
 *                               # value "end" terminates the workflow.
 *       branches:               # OPTIONAL decision routing. Key = the
 *         approve: re-confirm   # decision string the agent emits; value
 *         no-approve: end       # = step id (or "end").
 */

import { parse as yamlParse, stringify as yamlStringify } from 'yaml'

import type { Agent, AgentKind } from './agents-store'

export interface WorkflowStep {
  /** Stable step id; auto-generated if missing. */
  id: string
  /** Agent id reference into the roster. */
  agentId: string
  /** Free-text instruction shown in the composer. */
  note: string
  /** Explicit next step id, or "end". Defaults to next list element. */
  next?: string
  /** Decision branches keyed by agent-emitted decision string. */
  branches?: Record<string, string>
}

export interface Workflow {
  id: string
  name: string
  task: string
  createdAt: string
  steps: WorkflowStep[]
}

export const DEFAULT_WORKFLOWS: Workflow[] = [
  {
    id: 'wf-server-deletion',
    name: 'Server Deletion Workflow',
    task:
      `Decommission a server safely. L1 Triage validates the request and gathers context. ` +
      `ServiceNow files the change request and waits for approval. On approve → L1 Triage ` +
      `re-confirms scope, then AWS Agent terminates. On no-approve → workflow stops.`,
    createdAt: '2026-05-07T09:00:00Z',
    steps: [
      { id: 'triage', agentId: 'l1-triage-agent', note: 'Validate request, attach CMDB + owner, snapshot state' },
      {
        id: 'file-chg', agentId: 'servicenow-agent',
        note: 'File CHG, route to CAB, capture approve / no-approve',
        branches: { approve: 're-confirm', 'no-approve': 'end' },
      },
      { id: 're-confirm', agentId: 'l1-triage-agent', note: 'Re-confirm scope post-approval' },
      { id: 'terminate', agentId: 'aws-agent', note: 'Stop → snapshot → terminate → release EIP/ENI; log everything' },
    ],
  },
  {
    id: 'wf-cloudops-dashboard',
    name: 'Build cloudops-dashboard',
    task:
      `Take Jira ticket OPS-482 and ship a tiny CloudOps dashboard. ` +
      `Repo lives at ~/work/cloudops-dashboard. Deploy preview to Vercel staging, ` +
      `post the URL back to the Jira ticket, leave the ticket in "In Review".`,
    createdAt: '2026-05-06T14:21:00Z',
    steps: [
      { id: 'fetch-ticket', agentId: 'jira-agent',        note: 'Read OPS-482, parse criteria' },
      { id: 'spec',         agentId: 'spec-design-agent', note: 'Generate SPEC.md' },
      { id: 'implement',    agentId: 'coding-agent',      note: 'Scaffold + implement under SDD' },
      {
        id: 'review', agentId: 'code-review-agent',
        note: 'Review diff; route back to coding on issues',
        branches: { approved: 'deploy', issues: 'implement' },
      },
      { id: 'deploy', agentId: 'deploy-agent', note: 'Build + deploy + comment ticket' },
    ],
  },
]

const STORAGE_KEY = 'hive.workflows.v3'

export function loadWorkflows(): Workflow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Workflow[]
      if (Array.isArray(parsed)) return parsed
    }
  } catch { /* fallthrough */ }
  return DEFAULT_WORKFLOWS
}

export function saveWorkflows(workflows: Workflow[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(workflows)) } catch { /* ignore */ }
}

export function newWorkflow(): Workflow {
  return {
    id: 'wf-' + Math.random().toString(36).slice(2, 8),
    name: 'Untitled workflow',
    task: 'Describe the task this workflow accomplishes.',
    createdAt: new Date().toISOString(),
    steps: [],
  }
}

/* ===== YAML serialization ===== */

interface YamlAgent {
  id: string
  name: string
  kind: AgentKind
  model: string
  skills: string[]
  prompt: string
  role?: string
}

interface YamlFlowStep {
  id?: string
  agent: string
  note?: string
  next?: string
  branches?: Record<string, string>
}

interface YamlWorkflow {
  schema: 'hive.workflow/v1'
  id: string
  name: string
  task: string
  agents?: YamlAgent[]
  flow: YamlFlowStep[]
}

/** Serialize a workflow + the agent definitions it references to YAML.
 *  We inline only the agents the workflow uses so the file is portable. */
export function workflowToYaml(workflow: Workflow, roster: Agent[]): string {
  const usedIds = new Set(workflow.steps.map((s) => s.agentId))
  const usedAgents: YamlAgent[] = roster
    .filter((a) => usedIds.has(a.id))
    .map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      role: a.role,
      model: a.model,
      skills: a.skills,
      prompt: a.prompt,
    }))
  const yaml: YamlWorkflow = {
    schema: 'hive.workflow/v1',
    id: workflow.id,
    name: workflow.name,
    task: workflow.task,
    agents: usedAgents,
    flow: workflow.steps.map((s, i) => {
      const out: YamlFlowStep = { id: s.id || `step-${i + 1}`, agent: s.agentId }
      if (s.note) out.note = s.note
      if (s.next) out.next = s.next
      if (s.branches && Object.keys(s.branches).length > 0) out.branches = s.branches
      return out
    }),
  }
  return yamlStringify(yaml, { lineWidth: 100, blockQuote: 'literal' })
}

export interface ParsedYaml {
  workflow: Workflow
  inlinedAgents: Agent[]
  /** Agent ids referenced in flow but not provided inline AND not in passed roster. */
  missingAgentIds: string[]
  /** Skills referenced by inlined agents that don't exist in known skills. */
  missingSkills: string[]
}

/** Parse a YAML string into a Workflow plus reconciliation info.
 *  Throws on malformed YAML or invalid schema. */
export function parseWorkflowYaml(
  yamlText: string,
  existingRoster: Agent[],
  knownSkills: Set<string>,
): ParsedYaml {
  const raw = yamlParse(yamlText)
  if (!raw || typeof raw !== 'object') throw new Error('YAML must define a workflow object')
  const obj = raw as Record<string, unknown>
  if (obj.schema !== 'hive.workflow/v1') {
    throw new Error(`unknown schema ${String(obj.schema)} (expected hive.workflow/v1)`)
  }
  if (typeof obj.id !== 'string' || obj.id.length === 0) throw new Error('workflow.id required')
  if (typeof obj.name !== 'string' || obj.name.length === 0) throw new Error('workflow.name required')
  const task = typeof obj.task === 'string' ? obj.task : ''
  const flowRaw = obj.flow
  if (!Array.isArray(flowRaw) || flowRaw.length === 0) throw new Error('workflow.flow must be a non-empty list')

  // Inlined agents (optional).
  const inlinedAgents: Agent[] = []
  if (Array.isArray(obj.agents)) {
    for (const a of obj.agents as Array<Record<string, unknown>>) {
      if (typeof a.id !== 'string' || typeof a.name !== 'string') continue
      const kind = (typeof a.kind === 'string' ? a.kind : 'specialist') as AgentKind
      inlinedAgents.push({
        id: a.id,
        name: a.name,
        kind,
        role: typeof a.role === 'string' ? a.role : '',
        model: typeof a.model === 'string' ? a.model : 'claude-sonnet-4-5',
        skills: Array.isArray(a.skills) ? (a.skills as unknown[]).filter((s): s is string => typeof s === 'string') : [],
        prompt: typeof a.prompt === 'string' ? a.prompt : '',
      })
    }
  }

  // Steps.
  const steps: WorkflowStep[] = flowRaw.map((stepRaw, i) => {
    if (!stepRaw || typeof stepRaw !== 'object') throw new Error(`flow[${i}] must be an object`)
    const s = stepRaw as Record<string, unknown>
    if (typeof s.agent !== 'string' || s.agent.length === 0) throw new Error(`flow[${i}].agent required`)
    const out: WorkflowStep = {
      id: typeof s.id === 'string' && s.id.length > 0 ? s.id : `step-${i + 1}`,
      agentId: s.agent,
      note: typeof s.note === 'string' ? s.note : '',
    }
    if (typeof s.next === 'string' && s.next.length > 0) out.next = s.next
    if (s.branches && typeof s.branches === 'object') {
      const branches: Record<string, string> = {}
      for (const [k, v] of Object.entries(s.branches as Record<string, unknown>)) {
        if (typeof v === 'string' && v.length > 0) branches[k] = v
      }
      if (Object.keys(branches).length > 0) out.branches = branches
    }
    return out
  })

  const workflow: Workflow = {
    id: obj.id,
    name: obj.name,
    task,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
    steps,
  }

  // Reconcile.
  const rosterIds = new Set([...existingRoster.map((a) => a.id), ...inlinedAgents.map((a) => a.id)])
  const referencedAgents = new Set(steps.map((s) => s.agentId))
  const missingAgentIds: string[] = []
  for (const id of referencedAgents) {
    if (!rosterIds.has(id)) missingAgentIds.push(id)
  }

  const missingSkills: string[] = []
  for (const a of inlinedAgents) {
    for (const s of a.skills) {
      if (!knownSkills.has(s) && !missingSkills.includes(s)) missingSkills.push(s)
    }
  }

  return { workflow, inlinedAgents, missingAgentIds, missingSkills }
}

/** Build a placeholder agent for an id referenced but undefined.
 *  Used when an uploaded YAML refs an agent not provided inline. */
export function stubAgent(id: string): Agent {
  return {
    id,
    name: id.split(/[-_]/).map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ') || id,
    kind: 'specialist',
    role: 'Auto-generated stub. Edit on the Agents screen.',
    model: 'claude-sonnet-4-5',
    skills: [],
    prompt: `You are ${id}. (stub — fill in your actual prompt)`,
  }
}
