/**
 * Agents roster — localStorage-backed list of reusable agent definitions.
 * Workflow composer attaches these into ordered pipelines.
 */

export type AgentKind = 'router' | 'specialist' | 'reviewer' | 'operator' | 'writer'

export interface Agent {
  id: string
  name: string
  kind: AgentKind
  role: string
  model: string
  skills: string[]
  prompt: string
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
  },
  {
    id: 'spec-design-agent', name: 'Spec Design Agent', kind: 'writer',
    role: 'Turns ticket criteria into a SPEC.md',
    model: 'claude-sonnet-4-5',
    skills: ['spec-driven-development', 'writing-plans'],
    prompt: 'You are the Spec Design Agent. Convert acceptance criteria into a SPEC.md with sections: Goal, Non-goals, User stories, API surface, Acceptance grid.',
  },
  {
    id: 'coding-agent', name: 'Coding Agent', kind: 'specialist',
    role: 'Spec-Driven implementation',
    model: 'claude-sonnet-4-5',
    skills: ['spec-driven-development', 'codex'],
    prompt: 'You are the Coding Agent. Practice Spec-Driven Development: read SPEC.md, scaffold a repo, write the smallest implementation that satisfies the acceptance grid, commit per step.',
  },
  {
    id: 'code-review-agent', name: 'Code Review Agent', kind: 'reviewer',
    role: 'Reviews diff; routes back issues or approves',
    model: 'claude-sonnet-4-5',
    skills: ['codex'],
    prompt: 'You are the Code Review Agent. Review the diff against SPEC.md and team policy. Emit numbered issues OR APPROVED. Route back to coding-agent on issues.',
  },
  {
    id: 'l1-triage-agent', name: 'L1 Triage Agent', kind: 'router',
    role: 'Validates incoming requests; gathers CMDB context',
    model: 'claude-haiku-4-5',
    skills: ['query-servicenow', 'connecting-to-wk-aws'],
    prompt: 'You are the L1 Triage Agent. For any incoming request: resolve the host in CMDB, find its owner, run a policy gate-check (prod windows, dependency map, frozen tags), and snapshot the current state. Emit a structured triage report. Refuse if policy fails.',
  },
  {
    id: 'servicenow-agent', name: 'ServiceNow Agent', kind: 'reviewer',
    role: 'Files CHG; routes to CAB; returns approve / no-approve',
    model: 'claude-sonnet-4-5',
    skills: ['query-servicenow'],
    prompt: "You are the ServiceNow Agent. File a Change Request with the triage report attached, route it to the correct CAB group, then poll until a decision lands. Emit { decision: 'approve' | 'no-approve', chg_number, approver, reason }. On no-approve, halt the workflow.",
  },
  {
    id: 'aws-agent', name: 'AWS Agent', kind: 'operator',
    role: 'Executes AWS actions (server deletion, snapshot, EIP/ENI cleanup)',
    model: 'claude-sonnet-4-5',
    skills: ['connecting-to-wk-aws'],
    prompt: 'You are the AWS Agent. Only act after ServiceNow approves. Sequence: stop → snapshot (retain 30d) → terminate → release ENI/EIP. Log every API call to CloudTrail-tagged audit. If any step fails, roll back what you can and emit a structured failure report.',
  },
  {
    id: 'deploy-agent', name: 'Deploy Agent', kind: 'operator',
    role: 'Build, deploy, smoke-test, post URL',
    model: 'claude-haiku-4-5',
    skills: ['connecting-to-wk-aws', 'query-jira'],
    prompt: 'You are the Deploy Agent. After review approves, run build, push to staging, smoke-test, and comment back on the originating Jira ticket.',
  },
]

// Bump to v2 so users with stale localStorage from before the skill→SKILL.md
// rename get the fresh default roster (skills now point at real SKILL.md
// filenames like `query-jira` instead of synthetic `jira.fetch-ticket` refs).
const STORAGE_KEY = 'hive.agents.v2'

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
