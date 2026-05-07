/**
 * Agents roster — localStorage-backed list of reusable agent definitions.
 * Workflow composer attaches these into ordered pipelines.
 */

export type AgentKind = 'router' | 'specialist' | 'reviewer' | 'operator' | 'writer'

/** Typed input/output port on an agent (or workflow contract). */
export interface Field {
  name: string
  /** Free-form type tag — 'string', 'string[]', 'url', 'path', 'enum<a|b>', etc. */
  type: string
  required?: boolean
  desc?: string
}

export interface Agent {
  id: string
  name: string
  kind: AgentKind
  role: string
  model: string
  skills: string[]
  prompt: string
  /** Typed input contract — what the agent expects to receive. Optional for
   *  back-compat; agents without I/O schemas just don't show pins on the canvas. */
  inputs?: Field[]
  outputs?: Field[]
}

export const AGENT_KIND_META: Record<AgentKind, { color: string; icon: string; bg: string }> = {
  router:     { color: '#ffcb52', icon: 'swarm',    bg: 'rgba(255,203,82,0.10)' },
  reviewer:   { color: '#a78bfa', icon: 'tasks',    bg: 'rgba(167,139,250,0.10)' },
  operator:   { color: '#ff7a59', icon: 'ops',      bg: 'rgba(255,122,89,0.10)' },
  specialist: { color: '#8aff88', icon: 'terminal', bg: 'rgba(138,255,136,0.10)' },
  writer:     { color: '#1dacfe', icon: 'book',     bg: 'rgba(29,172,254,0.10)' },
}

export const DEFAULT_AGENT_ROSTER: Agent[] = [
  {
    id: 'jira-agent', name: 'Jira Agent', kind: 'router',
    role: 'Pulls tickets and parses acceptance criteria',
    model: 'claude-haiku-4-5',
    skills: ['query-jira'],
    prompt:
      'You are the Jira Agent. Use the `query-jira` skill (curl + JIRA_URL/JIRA_USERNAME/JIRA_API_TOKEN env vars) ' +
      'to fetch tickets, parse acceptance criteria, and emit a structured spec the next agent can consume.',
    inputs: [
      { name: 'ticket_key', type: 'string', required: true, desc: 'Jira ticket key (e.g. OPS-482)' },
    ],
    outputs: [
      { name: 'title',          type: 'string',   desc: 'Ticket title' },
      { name: 'acceptance',     type: 'string[]', desc: 'Bullet list of acceptance criteria' },
      { name: 'ticket_url',     type: 'url',      desc: 'Canonical link' },
      { name: 'reporter_email', type: 'email',    desc: 'Reporter (for follow-ups)' },
    ],
  },
  {
    id: 'spec-design-agent', name: 'Spec Design Agent', kind: 'writer',
    role: 'Turns ticket criteria into a SPEC.md',
    model: 'claude-sonnet-4-5',
    skills: ['spec-driven-development', 'writing-plans'],
    prompt: 'You are the Spec Design Agent. Convert acceptance criteria into a SPEC.md with sections: Goal, Non-goals, User stories, API surface, Acceptance grid.',
    inputs: [
      { name: 'title',      type: 'string',   required: true, desc: 'Ticket / feature title' },
      { name: 'acceptance', type: 'string[]', required: true, desc: 'Acceptance bullets' },
    ],
    outputs: [
      { name: 'spec_md',   type: 'markdown', desc: 'Full SPEC.md body' },
      { name: 'spec_path', type: 'path',     desc: 'Path on disk' },
    ],
  },
  {
    id: 'coding-agent', name: 'Coding Agent', kind: 'specialist',
    role: 'Spec-Driven implementation',
    model: 'claude-sonnet-4-5',
    skills: ['spec-driven-development', 'codex'],
    prompt: 'You are the Coding Agent. Practice Spec-Driven Development: read SPEC.md, scaffold a repo, write the smallest implementation that satisfies the acceptance grid, commit per step.',
    inputs: [
      { name: 'spec_path', type: 'path', required: true,  desc: 'SPEC.md to implement' },
      { name: 'repo_root', type: 'path', required: false, desc: 'Defaults to ~/work/<slug>' },
    ],
    outputs: [
      { name: 'diff',       type: 'patch',  desc: 'Unified diff produced' },
      { name: 'branch',     type: 'string', desc: 'Working branch name' },
      { name: 'commit_sha', type: 'sha',    desc: 'Latest commit' },
    ],
  },
  {
    id: 'code-review-agent', name: 'Code Review Agent', kind: 'reviewer',
    role: 'Reviews diff; routes back issues or approves',
    model: 'claude-sonnet-4-5',
    skills: ['codex'],
    prompt: 'You are the Code Review Agent. Review the diff against SPEC.md and team policy. Emit numbered issues OR APPROVED. Route back to coding-agent on issues.',
    inputs: [
      { name: 'diff',      type: 'patch', required: true, desc: 'Diff to review' },
      { name: 'spec_path', type: 'path',  required: true, desc: 'Spec to review against' },
    ],
    outputs: [
      { name: 'decision', type: 'enum<approve|changes>', desc: 'Approve or request changes' },
      { name: 'issues',   type: 'string[]',              desc: 'Numbered issue list (empty on approve)' },
    ],
  },
  {
    id: 'l1-triage-agent', name: 'L1 Triage Agent', kind: 'router',
    role: 'Validates incoming requests; gathers CMDB context',
    model: 'claude-haiku-4-5',
    skills: ['query-servicenow', 'connecting-to-wk-aws'],
    prompt: 'You are the L1 Triage Agent. For any incoming request: resolve the host in CMDB, find its owner, run a policy gate-check (prod windows, dependency map, frozen tags), and snapshot the current state. Emit a structured triage report. Refuse if policy fails.',
    inputs: [
      { name: 'host',         type: 'hostname',                   required: true, desc: 'Target server' },
      { name: 'request_type', type: 'enum<delete|reboot|patch>',  required: true, desc: 'Action requested' },
    ],
    outputs: [
      { name: 'triage_report', type: 'json',  desc: 'CMDB record, owner, policy verdict, state snapshot' },
      { name: 'owner_email',   type: 'email', desc: 'Owner of record' },
      { name: 'policy_pass',   type: 'bool',  desc: 'True only if all gates passed' },
    ],
  },
  {
    id: 'servicenow-agent', name: 'ServiceNow Agent', kind: 'reviewer',
    role: 'Files CHG; routes to CAB; returns approve / no-approve',
    model: 'claude-sonnet-4-5',
    skills: ['query-servicenow'],
    prompt: "You are the ServiceNow Agent. File a Change Request with the triage report attached, route it to the correct CAB group, then poll until a decision lands. Emit { decision: 'approve' | 'no-approve', chg_number, approver, reason }. On no-approve, halt the workflow.",
    inputs: [
      { name: 'triage_report', type: 'json',  required: true, desc: 'Evidence to attach' },
      { name: 'owner_email',   type: 'email', required: true, desc: 'For CC' },
    ],
    outputs: [
      { name: 'decision',   type: 'enum<approve|no-approve>', desc: 'CAB verdict' },
      { name: 'chg_number', type: 'string',                   desc: 'ServiceNow CHG####' },
      { name: 'approver',   type: 'string',                   desc: 'Approver name' },
      { name: 'reason',     type: 'string',                   desc: 'Free-text reason' },
    ],
  },
  {
    id: 'aws-agent', name: 'AWS Agent', kind: 'operator',
    role: 'Executes AWS actions (server deletion, snapshot, EIP/ENI cleanup)',
    model: 'claude-sonnet-4-5',
    skills: ['connecting-to-wk-aws'],
    prompt: 'You are the AWS Agent. Only act after ServiceNow approves. Sequence: stop → snapshot (retain 30d) → terminate → release ENI/EIP. Log every API call to CloudTrail-tagged audit. If any step fails, roll back what you can and emit a structured failure report.',
    inputs: [
      { name: 'host',       type: 'hostname',                   required: true, desc: 'Target instance' },
      { name: 'decision',   type: 'enum<approve|no-approve>',   required: true, desc: "Must be 'approve'" },
      { name: 'chg_number', type: 'string',                     required: true, desc: 'Audit reference' },
    ],
    outputs: [
      { name: 'instance_id',   type: 'string', desc: 'EC2 instance id terminated' },
      { name: 'snapshot_id',   type: 'string', desc: 'Snapshot retained' },
      { name: 'audit_log_url', type: 'url',    desc: 'CloudTrail audit reference' },
      { name: 'status',        type: 'enum<terminated|failed|rolled-back>', desc: 'Final state' },
    ],
  },
  {
    id: 'deploy-agent', name: 'Deploy Agent', kind: 'operator',
    role: 'Build, deploy, smoke-test, post URL',
    model: 'claude-haiku-4-5',
    skills: ['connecting-to-wk-aws', 'query-jira'],
    prompt: 'You are the Deploy Agent. After review approves, run build, push to staging, smoke-test, and comment back on the originating Jira ticket.',
    inputs: [
      { name: 'branch',     type: 'string',                required: true, desc: 'Branch to deploy' },
      { name: 'ticket_url', type: 'url',                   required: true, desc: 'For commenting back' },
      { name: 'decision',   type: 'enum<approve|changes>', required: true, desc: "Must be 'approve'" },
    ],
    outputs: [
      { name: 'preview_url', type: 'url',    desc: 'Live preview URL' },
      { name: 'build_log',   type: 'url',    desc: 'CI build log' },
      { name: 'smoke_pass',  type: 'bool',   desc: 'Smoke test result' },
    ],
  },
]

// v3: agents now ship with typed inputs/outputs schemas so the workflow
// canvas can show pin-to-pin wiring. Bump again for users on v2.
const STORAGE_KEY = 'hive.agents.v3'

export function loadAgents(): Agent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Agent[]
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
  } catch { /* fallthrough */ }
  return DEFAULT_AGENT_ROSTER
}

export function saveAgents(agents: Agent[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(agents)) } catch { /* ignore */ }
}
