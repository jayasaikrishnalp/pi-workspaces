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
    id: 'wf-l1-ritm-fetch',
    name: 'L1 Triage — free-form lookup',
    task:
      `Single-agent workflow. The user types a free-form prompt; L1 Triage ` +
      `extracts any RITM numbers (RITM####) or Jira keys (PROJ-###) and ` +
      `looks them up via mcp__servicenow__get_ritm / ` +
      `mcp__atlassian__jira_get_issue, then emits a markdown summary.`,
    createdAt: '2026-05-08T00:00:00Z',
    // Single free-form input rendered as a textarea (type: 'text' picks
    // the multi-line renderer in WorkflowsScreen). The agent extracts
    // any structured identifiers (RITM#, Jira key) from this text.
    inputs: [
      {
        name: 'prompt',
        type: 'text',
        required: true,
        desc: 'What should L1 Triage do? Mention any RITM numbers (e.g. RITM1873461) or Jira keys (e.g. OPS-482) you want looked up.',
      },
    ],
    outputs: [
      { name: 'summary', type: 'markdown', desc: 'Markdown summary of the lookup' },
    ],
    steps: [
      {
        id: 'triage',
        agentId: 'l1-triage-agent',
        note:
          'Read the user-supplied "prompt" from WORKFLOW INPUTS. ' +
          'Scan it for any RITM numbers matching /RITM\\d{5,}/i and any Jira keys matching /[A-Z][A-Z0-9]+-\\d+/. ' +
          'For each RITM found, call mcp__servicenow__get_ritm({ number, include_variables: true }). ' +
          'For each Jira key found, call mcp__atlassian__jira_get_issue({ issue_key }). ' +
          'If neither pattern is found, answer the prompt directly using the chat skills available. ' +
          'Always return a markdown summary in the `summary` output that clearly attributes which fields came from which record.',
        next: 'end',
      },
    ],
    bindings: [
      { to: 'triage.prompt', from: { kind: 'workflow', field: 'prompt' } },
      { to: 'out.summary',   from: { kind: 'step', stepId: 'triage', field: 'summary' } },
    ],
  },
]

// v10 replaces the structured ritm_number / jira_id inputs with a single
// free-form 'prompt' textarea. The agent extracts any RITM/Jira keys
// from the user's text. Rendering: type=text → textarea (multi-line).
// v9 extends the L1 workflow with a second input (jira_id) so the user
// can supply either or both a SNOW RITM and a Jira issue, and the agent
// fetches whichever is populated.
// v8 adds the missing workflow→step binding for ritm_number (v7 shipped
// the workflow without bindings, so the agent never received the typed
// input and refused with "missing required input"). v7 wipes prior set
// and ships a single minimal L1 Triage Agent
// workflow that reads a RITM via mcp__servicenow__get_ritm. Bumped from
// v6 so existing users get the reset without manually clearing localStorage.
const STORAGE_KEY = 'hive.workflows.v10'

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
