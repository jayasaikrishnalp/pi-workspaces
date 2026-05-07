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

import type { Agent, AgentKind, Field } from './agents-store'
export type { Field } from './agents-store'

export interface WorkflowStep {
  /** Stable step id; auto-generated if missing. */
  id: string
  /** Agent id reference into the roster. */
  agentId: string
  /** Free-text instruction shown in the composer (optional). */
  note?: string
  /** Explicit next step id, or "end". Defaults to next list element. */
  next?: string
  /** Decision branches keyed by agent-emitted decision string. */
  branches?: Record<string, string>
  /** Free-form canvas position for the React Flow renderer. Optional —
   *  when absent, the canvas auto-lays out the step on a column grid and
   *  the user can drag from there. */
  position?: { x: number; y: number }
}

/**
 * One typed binding: where does a step's input field (or the workflow's
 * output field) source its value from? Either the workflow's own input or
 * an upstream step's output.
 */
export type Binding =
  | { kind: 'workflow'; field: string }
  | { kind: 'step'; stepId: string; field: string }

/**
 * Pin-to-pin wiring. `to` follows `<stepId>.<field>` for step inputs, or
 * `out.<field>` for workflow outputs (the END node).
 */
export interface Edge {
  to: string
  from: Binding
}

export interface Workflow {
  id: string
  name: string
  task: string
  createdAt: string
  steps: WorkflowStep[]
  /** Workflow-level external inputs (the START node's output pins). Optional
   *  for back-compat — older workflows just omit this. */
  inputs?: Field[]
  /** Workflow-level outputs (the END node's input pins). */
  outputs?: Field[]
  /** Pin-to-pin wiring graph. When present, the runner can resolve typed
   *  values per step instead of relying on free-text prevOutput. */
  bindings?: Edge[]
  /** Canvas-level layout: positions of the synthetic START / END nodes.
   *  Steps store their own position in WorkflowStep.position. */
  layout?: { start?: { x: number; y: number }; end?: { x: number; y: number } }
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
    inputs: [
      { name: 'host',         type: 'hostname',                  required: true, desc: 'Instance to delete' },
      { name: 'request_type', type: 'enum<delete|reboot|patch>', required: true, desc: "Always 'delete' for this flow" },
    ],
    outputs: [
      { name: 'status',        type: 'enum<terminated|failed|rolled-back>' },
      { name: 'snapshot_id',   type: 'string' },
      { name: 'audit_log_url', type: 'url' },
    ],
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
    bindings: [
      // L1 triage inputs come from the workflow's external inputs
      { to: 'triage.host',         from: { kind: 'workflow', field: 'host' } },
      { to: 'triage.request_type', from: { kind: 'workflow', field: 'request_type' } },
      // ServiceNow gets the triage report + owner email
      { to: 'file-chg.triage_report', from: { kind: 'step', stepId: 'triage', field: 'triage_report' } },
      { to: 'file-chg.owner_email',   from: { kind: 'step', stepId: 'triage', field: 'owner_email' } },
      // Re-confirm just re-runs L1 triage (same inputs from workflow)
      { to: 're-confirm.host',         from: { kind: 'workflow', field: 'host' } },
      { to: 're-confirm.request_type', from: { kind: 'workflow', field: 'request_type' } },
      // AWS terminator gets host + the CAB decision + ticket number (CHG####)
      { to: 'terminate.host',       from: { kind: 'workflow', field: 'host' } },
      { to: 'terminate.decision',   from: { kind: 'step', stepId: 'file-chg', field: 'decision' } },
      { to: 'terminate.chg_number', from: { kind: 'step', stepId: 'file-chg', field: 'ticket_number' } },
      // Workflow outputs from the AWS step
      { to: 'out.status',        from: { kind: 'step', stepId: 'terminate', field: 'status' } },
      { to: 'out.snapshot_id',   from: { kind: 'step', stepId: 'terminate', field: 'snapshot_id' } },
      { to: 'out.audit_log_url', from: { kind: 'step', stepId: 'terminate', field: 'audit_log_url' } },
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
    inputs: [
      { name: 'ticket_key', type: 'string', required: true, desc: 'e.g. OPS-482' },
    ],
    outputs: [
      { name: 'preview_url', type: 'url' },
      { name: 'branch',      type: 'string' },
      { name: 'smoke_pass',  type: 'bool' },
    ],
    steps: [
      { id: 'fetch-ticket', agentId: 'jira-agent',        note: 'Read OPS-482, parse criteria' },
      { id: 'spec',         agentId: 'spec-design-agent', note: 'Generate SPEC.md' },
      { id: 'implement',    agentId: 'coding-agent',      note: 'Scaffold + implement under SDD' },
      {
        id: 'review', agentId: 'code-review-agent',
        note: 'Review diff; route back to coding on issues',
        branches: { approve: 'deploy', changes: 'implement' },
      },
      { id: 'deploy', agentId: 'deploy-agent', note: 'Build + deploy + comment ticket' },
    ],
    bindings: [
      // Jira agent input ← workflow input
      { to: 'fetch-ticket.ticket_key', from: { kind: 'workflow', field: 'ticket_key' } },
      // Spec from Jira outputs
      { to: 'spec.title',      from: { kind: 'step', stepId: 'fetch-ticket', field: 'title' } },
      { to: 'spec.acceptance', from: { kind: 'step', stepId: 'fetch-ticket', field: 'acceptance' } },
      // Coding from spec
      { to: 'implement.spec_path', from: { kind: 'step', stepId: 'spec', field: 'spec_path' } },
      // Review from coding diff + spec
      { to: 'review.diff',      from: { kind: 'step', stepId: 'implement', field: 'diff' } },
      { to: 'review.spec_path', from: { kind: 'step', stepId: 'spec',      field: 'spec_path' } },
      // Deploy from coding branch + Jira ticket url + review decision
      { to: 'deploy.branch',     from: { kind: 'step', stepId: 'implement',    field: 'branch' } },
      { to: 'deploy.ticket_url', from: { kind: 'step', stepId: 'fetch-ticket', field: 'ticket_url' } },
      { to: 'deploy.decision',   from: { kind: 'step', stepId: 'review',       field: 'decision' } },
      // Workflow outputs
      { to: 'out.preview_url', from: { kind: 'step', stepId: 'deploy',    field: 'preview_url' } },
      { to: 'out.branch',      from: { kind: 'step', stepId: 'implement', field: 'branch' } },
      { to: 'out.smoke_pass',  from: { kind: 'step', stepId: 'deploy',    field: 'smoke_pass' } },
    ],
  },
  {
    id: 'wf-ritm-fulfilment',
    name: 'RITM Fulfilment (AWS / Azure)',
    task:
      `Fulfil a ServiceNow RITM end-to-end. L1 Triage parses the RITM and decides ` +
      `if the mandatory fields are complete; AWS or Azure Agent creates the resource; ` +
      `if mandatory fields are missing the workflow loops back to ServiceNow Agent which ` +
      `posts a work_notes asking the user to update the RITM. Once the RITM is updated ` +
      `the user re-runs the workflow and the agents pick up the new fields. ` +
      `On success ServiceNow Agent posts the fulfilment work_notes and L1 Triage emits a final summary.`,
    createdAt: '2026-05-07T18:00:00Z',
    inputs: [
      { name: 'ritm_number', type: 'string',         required: true,  desc: 'RITM#### to fulfil (e.g. RITM1873427)' },
      { name: 'cloud',       type: 'enum<aws|azure>', required: false, desc: 'Override cloud — by default L1 Triage detects from the RITM description' },
    ],
    outputs: [
      { name: 'status',      type: 'enum<success|missing|failed>', desc: 'Final fulfilment status' },
      { name: 'instance_id', type: 'string',                       desc: 'Created resource id (success only)' },
      { name: 'summary',     type: 'markdown',                     desc: 'End-of-run markdown summary' },
    ],
    steps: [
      // 1) Parse the RITM, identify cloud + mandatory fields, route.
      {
        id: 'triage-ritm',
        agentId: 'l1-triage-agent',
        note: 'Read RITM via get_ritm; parse mandatory fields; emit decision (complete | missing).',
        branches: { complete: 'cloud-fulfil', missing: 'snow-flag-missing' },
      },
      // 2a) Mandatory fields complete → try the cloud action. The workflow
      //     defaults to AWS; users with Azure RITMs swap this step's agent
      //     to azure-agent on the canvas.
      {
        id: 'cloud-fulfil',
        agentId: 'aws-agent',
        note: 'Create the resource described in the RITM. On missing fields, route back to ServiceNow Agent.',
        branches: { success: 'snow-update-success', missing: 'snow-flag-missing', failed: 'snow-flag-missing' },
      },
      // 2b) Missing/failed → ServiceNow Agent posts a work_notes asking the
      //     user to update the RITM. Workflow ends here; user re-runs once
      //     the RITM is updated.
      {
        id: 'snow-flag-missing',
        agentId: 'servicenow-agent',
        note: 'Post a work_notes on the RITM listing the missing fields and asking the user to update. End the workflow — user re-runs after RITM is updated.',
        next: 'end',
      },
      // 3) Success → ServiceNow Agent posts completion work_notes (and
      //    cascade-closes the linked sc_task → RITM if the RITM is fully
      //    fulfilled).
      {
        id: 'snow-update-success',
        agentId: 'servicenow-agent',
        note: 'Post completion work_notes with instance details. Cascade-close sc_task → RITM → sc_request when fully fulfilled.',
      },
      // 4) Final markdown summary the user can read in Slack.
      { id: 'summary', agentId: 'l1-triage-agent', note: 'Mode C — write a markdown summary of the whole interaction for the user.', next: 'end' },
    ],
    bindings: [
      // L1 Triage receives the RITM number from workflow input.
      { to: 'triage-ritm.ritm_number', from: { kind: 'workflow', field: 'ritm_number' } },

      // AWS Agent receives the parsed payload + RITM number for tagging.
      { to: 'cloud-fulfil.parsed_ritm', from: { kind: 'step', stepId: 'triage-ritm', field: 'parsed_ritm' } },
      { to: 'cloud-fulfil.ritm_number', from: { kind: 'workflow', field: 'ritm_number' } },

      // ServiceNow Agent (missing path) — passes the RITM number + summary
      // explaining what's missing. The summary comes from whichever step
      // routed here (triage if RITM-level, cloud if cloud-level).
      { to: 'snow-flag-missing.ritm_number', from: { kind: 'workflow', field: 'ritm_number' } },

      // ServiceNow Agent (success path) — receives RITM + the AWS audit log
      // url so the work_notes can link to it.
      { to: 'snow-update-success.ritm_number', from: { kind: 'workflow', field: 'ritm_number' } },

      // Final summary step — the L1 Triage Agent in Mode C reads the
      // instance_id + status from the AWS step and emits a markdown summary.
      { to: 'summary.instance_id',   from: { kind: 'step', stepId: 'cloud-fulfil', field: 'instance_id' } },
      { to: 'summary.fulfil_status', from: { kind: 'step', stepId: 'cloud-fulfil', field: 'fulfil_status' } },
      { to: 'summary.ritm_number',   from: { kind: 'workflow', field: 'ritm_number' } },

      // Workflow-level outputs.
      { to: 'out.status',      from: { kind: 'step', stepId: 'cloud-fulfil', field: 'fulfil_status' } },
      { to: 'out.instance_id', from: { kind: 'step', stepId: 'cloud-fulfil', field: 'instance_id' } },
      { to: 'out.summary',     from: { kind: 'step', stepId: 'summary',      field: 'summary' } },
    ],
  },
  {
    id: 'wf-hackathon-demo',
    name: 'Hackathon Demo: ServiceNow → AWS Provisioning',
    task:
      `End-to-end demo. Given a ServiceNow incident number, L1 Triage reads ` +
      `the incident via mcp__servicenow__get_incident, parses the embedded ` +
      `mandatory fields (cloud, account, region, instance_type, ami, subnet, ` +
      `etc.) from the description, and hands them to AWS Agent. AWS Agent ` +
      `assumes WKFedRoles-Operations into the target WK account using the ` +
      `connecting-to-wk-aws skill (which now ALWAYS unsets AWS_SESSION_TOKEN ` +
      `first), launches the t3.small EC2, tags it with the inc number + owner, ` +
      `and returns instance_id + ip + launch_time. ServiceNow Agent posts a ` +
      `work_notes with the result; on success it resolves the incident with ` +
      `close_code 'Solved (Permanently)', on AWS failure it posts the error ` +
      `as work_notes and leaves the incident in progress. L1 Triage emits a ` +
      `final markdown summary of the whole interaction.`,
    createdAt: '2026-05-07T15:30:00Z',
    inputs: [
      { name: 'inc_number', type: 'string', required: true, desc: 'ServiceNow incident number, e.g. INC3524652' },
    ],
    outputs: [
      { name: 'status',      type: 'enum<provisioned|failed>', desc: 'Whether the AWS resource was created' },
      { name: 'instance_id', type: 'string',                   desc: 'EC2 instance id (success only)' },
      { name: 'summary',     type: 'markdown',                 desc: 'Final markdown summary of the run' },
    ],
    steps: [
      {
        id: 'triage',
        agentId: 'l1-triage-agent',
        note:
          'Read the incident with mcp__servicenow__get_incident. Parse the ' +
          'mandatory fields from .description (cloud, account, region, ' +
          'instance_type, ami, subnet, env, owner). Emit a structured handoff ' +
          'for AWS Agent with all fields needed to provision.',
      },
      {
        id: 'provision',
        agentId: 'aws-agent',
        note:
          'Use the connecting-to-wk-aws skill — source the helper or follow ' +
          'Steps 0.4 → 0.5 → 1 → 2 in one Bash call. Unset AWS_SESSION_TOKEN ' +
          'FIRST. Assume WKFedRoles-Operations into the target account from ' +
          'triage. Launch one t3.small with the requested ami in the requested ' +
          'subnet, tag {Name: hive-hackathon-<inc>, env: dev, owner: <owner>, ' +
          'inc: <inc>}. Wait for state=running. Return instance_id, public_ip ' +
          '(or private_ip if no EIP), launch_time. On any failure, return ' +
          'status=failed plus the error message — DO NOT raise; pass it on.',
      },
      {
        id: 'snow-update',
        agentId: 'servicenow-agent',
        note:
          'Post a work_notes on the incident via mcp__servicenow__update_incident. ' +
          'Body: instance_id + ip + launch_time on success, or the AWS error ' +
          'on failure. On success, also resolve the incident: ' +
          'mcp__servicenow__resolve_incident with close_code "Solved ' +
          '(Permanently)" and close_notes summarising what was provisioned. ' +
          'On failure, leave the incident in In Progress (state=2).',
      },
      {
        id: 'summary',
        agentId: 'l1-triage-agent',
        note:
          'Mode C — write a markdown summary of the entire interaction for the ' +
          'demo audience. Sections: 1) what the incident asked for, ' +
          '2) what was parsed, 3) what AWS provisioned (or why it failed), ' +
          '4) what ServiceNow was updated with, 5) the final state of the ' +
          'incident.',
        next: 'end',
      },
    ],
  },
]

// v5 ships the RITM Fulfilment workflow + the ticket_number rename + the
// extended L1/AWS/Azure agent contracts. Bumped from v4 so users get the
// new default workflow without manually clearing localStorage.
const STORAGE_KEY = 'hive.workflows.v5'

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

interface YamlField {
  name: string
  type: string
  required?: boolean
  desc?: string
}

interface YamlAgent {
  id: string
  name: string
  kind: AgentKind
  model: string
  skills: string[]
  prompt: string
  role?: string
  inputs?: YamlField[]
  outputs?: YamlField[]
}

interface YamlFlowStep {
  id?: string
  agent: string
  note?: string
  next?: string
  branches?: Record<string, string>
  position?: { x: number; y: number }
}

interface YamlBinding {
  to: string
  from: string  // serialized: 'workflow.<field>' | '<stepId>.<field>'
}

interface YamlWorkflow {
  schema: 'hive.workflow/v1'
  id: string
  name: string
  task: string
  inputs?: YamlField[]
  outputs?: YamlField[]
  agents?: YamlAgent[]
  flow: YamlFlowStep[]
  bindings?: YamlBinding[]
  layout?: { start?: { x: number; y: number }; end?: { x: number; y: number } }
}

function bindingToString(b: Binding): string {
  return b.kind === 'workflow' ? `workflow.${b.field}` : `${b.stepId}.${b.field}`
}

function bindingFromString(s: string): Binding | null {
  const dot = s.indexOf('.')
  if (dot < 1) return null
  const lhs = s.slice(0, dot)
  const field = s.slice(dot + 1)
  if (!field) return null
  if (lhs === 'workflow') return { kind: 'workflow', field }
  return { kind: 'step', stepId: lhs, field }
}

/** Serialize a workflow + the agent definitions it references to YAML.
 *  We inline only the agents the workflow uses so the file is portable. */
export function workflowToYaml(workflow: Workflow, roster: Agent[]): string {
  const usedIds = new Set(workflow.steps.map((s) => s.agentId))
  const usedAgents: YamlAgent[] = roster
    .filter((a) => usedIds.has(a.id))
    .map((a) => {
      const out: YamlAgent = {
        id: a.id, name: a.name, kind: a.kind, role: a.role,
        model: a.model, skills: a.skills, prompt: a.prompt,
      }
      if (a.inputs && a.inputs.length > 0) out.inputs = a.inputs
      if (a.outputs && a.outputs.length > 0) out.outputs = a.outputs
      return out
    })
  const yaml: YamlWorkflow = {
    schema: 'hive.workflow/v1',
    id: workflow.id,
    name: workflow.name,
    task: workflow.task,
    ...(workflow.inputs && workflow.inputs.length > 0 ? { inputs: workflow.inputs } : {}),
    ...(workflow.outputs && workflow.outputs.length > 0 ? { outputs: workflow.outputs } : {}),
    agents: usedAgents,
    flow: workflow.steps.map((s, i) => {
      const out: YamlFlowStep = { id: s.id || `step-${i + 1}`, agent: s.agentId }
      if (s.note) out.note = s.note
      if (s.next) out.next = s.next
      if (s.branches && Object.keys(s.branches).length > 0) out.branches = s.branches
      if (s.position) out.position = s.position
      return out
    }),
    ...(workflow.bindings && workflow.bindings.length > 0 ? {
      bindings: workflow.bindings.map((b) => ({ to: b.to, from: bindingToString(b.from) })),
    } : {}),
    ...(workflow.layout ? { layout: workflow.layout } : {}),
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
  const parseFields = (raw: unknown): Field[] | undefined => {
    if (!Array.isArray(raw)) return undefined
    const out: Field[] = []
    for (const f of raw as Array<Record<string, unknown>>) {
      if (!f || typeof f !== 'object') continue
      if (typeof f.name !== 'string' || typeof f.type !== 'string') continue
      const field: Field = { name: f.name, type: f.type }
      if (typeof f.required === 'boolean') field.required = f.required
      if (typeof f.desc === 'string') field.desc = f.desc
      out.push(field)
    }
    return out.length > 0 ? out : undefined
  }

  const inlinedAgents: Agent[] = []
  if (Array.isArray(obj.agents)) {
    for (const a of obj.agents as Array<Record<string, unknown>>) {
      if (typeof a.id !== 'string' || typeof a.name !== 'string') continue
      const kind = (typeof a.kind === 'string' ? a.kind : 'specialist') as AgentKind
      const agent: Agent = {
        id: a.id,
        name: a.name,
        kind,
        role: typeof a.role === 'string' ? a.role : '',
        model: typeof a.model === 'string' ? a.model : 'claude-sonnet-4-5',
        skills: Array.isArray(a.skills) ? (a.skills as unknown[]).filter((s): s is string => typeof s === 'string') : [],
        prompt: typeof a.prompt === 'string' ? a.prompt : '',
      }
      const inputs = parseFields(a.inputs)
      const outputs = parseFields(a.outputs)
      if (inputs) agent.inputs = inputs
      if (outputs) agent.outputs = outputs
      inlinedAgents.push(agent)
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
    if (s.position && typeof s.position === 'object') {
      const p = s.position as { x?: unknown; y?: unknown }
      if (typeof p.x === 'number' && typeof p.y === 'number') out.position = { x: p.x, y: p.y }
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
  const wfInputs = parseFields(obj.inputs)
  const wfOutputs = parseFields(obj.outputs)
  if (wfInputs) workflow.inputs = wfInputs
  if (wfOutputs) workflow.outputs = wfOutputs

  if (obj.layout && typeof obj.layout === 'object') {
    const lay = obj.layout as Record<string, unknown>
    const parsePoint = (raw: unknown): { x: number; y: number } | undefined => {
      if (!raw || typeof raw !== 'object') return undefined
      const p = raw as { x?: unknown; y?: unknown }
      if (typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y }
      return undefined
    }
    const layout: Workflow['layout'] = {}
    const start = parsePoint(lay.start)
    const end = parsePoint(lay.end)
    if (start) layout.start = start
    if (end) layout.end = end
    if (layout.start || layout.end) workflow.layout = layout
  }

  // Bindings (typed pin-to-pin map). YAML form is { to, from } where `from`
  // is a dotted string ("workflow.<field>" | "<stepId>.<field>").
  if (Array.isArray(obj.bindings)) {
    const bindings: Edge[] = []
    for (const b of obj.bindings as Array<Record<string, unknown>>) {
      if (!b || typeof b !== 'object') continue
      if (typeof b.to !== 'string' || typeof b.from !== 'string') continue
      const from = bindingFromString(b.from)
      if (!from) continue
      bindings.push({ to: b.to, from })
    }
    if (bindings.length > 0) workflow.bindings = bindings
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
