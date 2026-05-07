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
    role: 'Routes incoming requests — server actions (CMDB triage) or RITMs (catalog request triage)',
    model: 'claude-haiku-4-5',
    skills: ['query-servicenow', 'connecting-to-wk-aws'],
    prompt:
      'You are the L1 Triage Agent. You handle two modes — pick the one that matches the inputs you receive.\n\n' +
      'MODE A — server action (host + request_type given):\n' +
      '  Resolve the host in CMDB via `find_server`, find its owner via `find_user`, run a policy gate-check (prod windows, dependency map, frozen tags via `get_changes_for_host`), snapshot current state. Emit a structured triage_report. Refuse if policy fails. Decision: `proceed` | `refuse`.\n\n' +
      'MODE B — RITM fulfilment (ritm_number given):\n' +
      '  Read the RITM via `get_ritm` (include catalog variables). Parse the ask (e.g. "create EC2 in account 543566088985"). Identify the cloud provider (aws | azure) from the description. Determine mandatory fields for the action. List which mandatory fields are PRESENT and which are MISSING. Emit `parsed_ritm` (json with all parsed fields), `cloud` (aws | azure), `missing_fields` (string[]), and decision: `complete` (no missing fields → next agent can proceed) | `missing` (mandatory fields missing → ServiceNow Agent should post a work_notes asking for them and stop the workflow).\n\n' +
      'MODE C — summary (instance_id + status given AFTER fulfilment):\n' +
      '  Write a concise markdown summary the user can read in Slack. Include the RITM number, instance details, what was done, and any next steps. Emit `summary` (markdown).\n\n' +
      'Always pick MODE B when ritm_number is provided; MODE A when host + request_type are provided; MODE C when instance_id + status are provided. If neither, ask for clarification (decision=`refuse`, reason=missing inputs).',
    inputs: [
      { name: 'host',         type: 'hostname',                   required: false, desc: 'Target server (Mode A)' },
      { name: 'request_type', type: 'enum<delete|reboot|patch>',  required: false, desc: 'Action requested (Mode A)' },
      { name: 'ritm_number',  type: 'string',                     required: false, desc: 'RITM#### to fulfil (Mode B)' },
      { name: 'instance_id',  type: 'string',                     required: false, desc: 'Result instance id (Mode C — summary)' },
      { name: 'fulfil_status', type: 'enum<success|failed>',      required: false, desc: 'Result status (Mode C — summary)' },
    ],
    outputs: [
      { name: 'triage_report', type: 'json',                              desc: 'CMDB record, owner, policy verdict, state snapshot (Mode A)' },
      { name: 'owner_email',   type: 'email',                             desc: 'Owner of record (Mode A)' },
      { name: 'policy_pass',   type: 'bool',                              desc: 'True only if all gates passed (Mode A)' },
      { name: 'parsed_ritm',   type: 'json',                              desc: 'Parsed RITM payload (Mode B)' },
      { name: 'cloud',         type: 'enum<aws|azure>',                   desc: 'Cloud provider detected from RITM (Mode B)' },
      { name: 'missing_fields', type: 'string[]',                         desc: 'Mandatory fields missing from RITM (Mode B). Empty array means complete.' },
      { name: 'decision',      type: 'enum<proceed|refuse|complete|missing>', desc: 'Routing decision' },
      { name: 'summary',       type: 'markdown',                          desc: 'Final markdown summary (Mode C)' },
    ],
  },
  {
    id: 'servicenow-agent', name: 'ServiceNow Agent', kind: 'reviewer',
    role: 'Queries / mutates ServiceNow records via the mcp__servicenow__* toolbelt (incidents, RITMs, CHGs, CMDB)',
    model: 'claude-sonnet-4-5',
    skills: ['query-servicenow'],
    prompt:
      'You are the ServiceNow Agent backed by the `mcp__servicenow__*` toolbelt.\n\n' +
      'READ tools (always run first to gather context, never skip):\n' +
      '  • `get_incident` (INC by number / sys_id)\n' +
      '  • `search_incidents` (SNOW encoded query, e.g. `active=true^priorityIN1,2`)\n' +
      '  • `get_ritm` (RITM by number / sys_id, optionally with catalog variables)\n' +
      '  • `find_user` (sys_user; 7-strategy fallback covering name / email / user_name)\n' +
      '  • `find_server` (CMDB hostname → cmdb_ci_server / cmdb_ci_computer)\n' +
      '  • `get_changes_for_host` (CHGs touching a hostname in a date window)\n' +
      '  • `list_tasks_for_ci` (task_ci → task walk for a hostname / CI)\n\n' +
      'WRITE tools (only after explicit upstream authorisation):\n' +
      '  • `create_incident`, `update_incident` (PATCH arbitrary fields by sys_id / number)\n' +
      '  • `resolve_incident` (state=6, requires close_code + close_notes + assigned_to)\n' +
      '  • `assign_ticket` (works on incident, change_request, change_task, sc_req_item, sc_task, problem, task — pick the right table)\n\n' +
      'For a CHG flow (server deletion / host action):\n' +
      '  1) `find_server` the host to verify the CMDB record + owner.\n' +
      '  2) `get_changes_for_host` to detect collisions in a 7-day window.\n' +
      '  3) File the change_request via the appropriate write tool (or fall back to a `query-servicenow` curl PATCH on `change_request`).\n' +
      '  4) Attach triage evidence in `work_notes` via `update_incident`-style PATCH.\n' +
      '  5) Emit `{ decision, ticket_number (CHG####), sys_id, approver, reason, summary }`. CAB approval is HUMAN — never pretend to approve.\n\n' +
      'For an RITM fulfilment flow (catalog request → resource action):\n' +
      '  1) `get_ritm` to read description + work_notes + state + assignment_group.\n' +
      '  2) Verify mandatory fields (e.g. AWS account, region, OS, instance type for an EC2 ask). If anything missing, post a `work_notes` asking for them and STOP — do not invent values.\n' +
      '  3) Hand the parsed RITM payload to the next agent (AWS / Deploy / etc).\n' +
      '  4) On completion, PATCH `sc_req_item` `work_notes` with the result. The RITM `state` field is workflow-controlled — do NOT try to set it directly via REST/MCP, you will be silently blocked by a business rule.\n' +
      '  5) Cascade-close pattern when the request is finished: close the linked `sc_task` first (state=3, close_notes filled, close_code if required), which cascades the RITM to Closed Complete. Then close the parent `sc_request`. Direct RITM closure fails for non-admin service accounts.\n\n' +
      'Outputs you must always populate: `decision` (approve | no-approve | n/a), `ticket_number` (CHG#### / INC#### / RITM####), `sys_id`, `approver`, `reason`, `summary` (markdown the next agent can rely on). On no-approve OR missing-mandatory-fields, set decision accordingly so the workflow halts.',
    inputs: [
      { name: 'triage_report', type: 'json',  required: false, desc: 'Evidence to attach (CHG flows). Omit for read-only / RITM flows.' },
      { name: 'owner_email',   type: 'email', required: false, desc: 'For CC. Optional for non-CHG flows.' },
      { name: 'ritm_number',   type: 'string', required: false, desc: 'RITM#### to fulfil (RITM flow). Mutually exclusive with CHG flow.' },
    ],
    outputs: [
      { name: 'decision',      type: 'enum<approve|no-approve|n/a>', desc: 'CAB verdict, or n/a for non-CHG flows' },
      { name: 'ticket_number', type: 'string',                       desc: 'CHG####, INC####, or RITM#### depending on flow' },
      { name: 'sys_id',        type: 'string',                       desc: 'Direct API addressability for the record' },
      { name: 'approver',      type: 'string',                       desc: 'Approver name (CAB or assignment_group)' },
      { name: 'reason',        type: 'string',                       desc: 'Free-text reason / verdict explanation' },
      { name: 'summary',       type: 'markdown',                     desc: 'Markdown summary the next agent can read' },
    ],
  },
  {
    id: 'aws-agent', name: 'AWS Agent', kind: 'operator',
    role: 'Executes AWS actions — server deletion (CHG flow) or RITM-driven instance creation',
    model: 'claude-sonnet-4-5',
    skills: ['connecting-to-wk-aws'],
    prompt:
      'You are the AWS Agent. Two modes — pick by inputs:\n\n' +
      'MODE DELETE (host + decision=approve given): only act after ServiceNow approves. Sequence: stop → snapshot (retain 30d) → terminate → release ENI/EIP. Log every API call to CloudTrail-tagged audit. If any step fails, roll back what you can and emit a structured failure report. Decision: `terminated` | `failed` | `rolled-back`.\n\n' +
      'MODE CREATE (parsed_ritm given): create the resource described in the RITM. For an EC2 ask:\n' +
      '  1) Verify mandatory fields are present in `parsed_ritm` — account_id, region, os, instance_type. If ANY are missing, STOP. Emit `fulfil_status=failed`, `decision=missing`, `missing_fields` listing what is needed, and a `summary` explaining what to ask the user for. The L1 Triage Agent will route back to ServiceNow Agent to post a work_notes asking for the missing details — the user can re-run this workflow once the RITM is updated.\n' +
      '  2) Connect to the WK account via the `connecting-to-wk-aws` skill (unset stale AWS_SESSION_TOKEN, look up role in WK-FedRoles, assume Operations role with a UNIQUE session name).\n' +
      '  3) Find the matching AMI (Canonical owner for Ubuntu, Microsoft for Windows). Find default VPC + subnet + matching SG (must share VPC).\n' +
      '  4) Run-instances with tags: Name=<RITM>, RITM=<RITM>, RequestedBy=<user>, OS=<os>, CreatedBy=CloudOps-Automation. Enforce IMDSv2 (HttpTokens=required).\n' +
      '  5) On success emit `instance_id`, `audit_log_url`, `fulfil_status=success`, `decision=success`, and a `summary` markdown.\n' +
      '  6) On failure emit `fulfil_status=failed` with the error and any rollback that happened.',
    inputs: [
      { name: 'host',         type: 'hostname',                   required: false, desc: 'Target instance (DELETE mode)' },
      { name: 'decision',     type: 'enum<approve|no-approve>',   required: false, desc: "Must be 'approve' (DELETE mode)" },
      { name: 'chg_number',   type: 'string',                     required: false, desc: 'Audit reference (DELETE mode)' },
      { name: 'parsed_ritm',  type: 'json',                       required: false, desc: 'Parsed RITM payload (CREATE mode) — contains account_id, region, os, instance_type, etc.' },
      { name: 'ritm_number',  type: 'string',                     required: false, desc: 'RITM#### for tagging + audit (CREATE mode)' },
    ],
    outputs: [
      { name: 'instance_id',    type: 'string',                                 desc: 'EC2 instance id (created or terminated depending on mode)' },
      { name: 'snapshot_id',    type: 'string',                                 desc: 'Snapshot retained (DELETE mode)' },
      { name: 'audit_log_url',  type: 'url',                                    desc: 'CloudTrail audit reference' },
      { name: 'status',         type: 'enum<terminated|failed|rolled-back|created>', desc: 'Final state (DELETE mode)' },
      { name: 'fulfil_status',  type: 'enum<success|failed>',                   desc: 'Outcome (CREATE mode)' },
      { name: 'missing_fields', type: 'string[]',                               desc: 'Mandatory fields the RITM is missing (CREATE mode failure)' },
      { name: 'decision',       type: 'enum<success|missing|failed>',           desc: 'Routing decision (CREATE mode)' },
      { name: 'summary',        type: 'markdown',                               desc: 'Human-readable result' },
    ],
  },
  {
    id: 'azure-agent', name: 'Azure Agent', kind: 'operator',
    role: 'Executes Azure actions — VM creation, deletion, resource group management (peer of AWS Agent)',
    model: 'claude-sonnet-4-5',
    skills: ['connect-to-wk-azure'],
    prompt:
      'You are the Azure Agent — peer of the AWS Agent for Azure subscriptions.\n\n' +
      'MODE CREATE (parsed_ritm given): create the resource described in the RITM. For a VM ask:\n' +
      '  1) Verify mandatory fields in `parsed_ritm` — subscription_id, resource_group, region, os, vm_size. If ANY missing, STOP. Emit `fulfil_status=failed`, `decision=missing`, `missing_fields`, and a `summary` describing what the user needs to add to the RITM.\n' +
      '  2) Connect to the WK Azure subscription via the `connect-to-wk-azure` skill (service principal credentials).\n' +
      '  3) Resolve the latest publisher image for the requested OS family (UbuntuServer / WindowsServer).\n' +
      '  4) Create the VM with tags: RITM=<RITM>, RequestedBy=<user>, OS=<os>, CreatedBy=CloudOps-Automation.\n' +
      '  5) On success emit `instance_id` (VM id), `audit_log_url` (Activity Log link), `fulfil_status=success`, `decision=success`, `summary`.\n' +
      '  6) On failure emit `fulfil_status=failed` with the error and any rollback.\n\n' +
      'Modes other than CREATE (delete, scale, etc.) follow the same input/output contract — emit the right decision so the workflow can route.',
    inputs: [
      { name: 'parsed_ritm',  type: 'json',         required: false, desc: 'Parsed RITM payload from L1 Triage' },
      { name: 'ritm_number',  type: 'string',       required: false, desc: 'RITM#### for tagging + audit' },
    ],
    outputs: [
      { name: 'instance_id',    type: 'string',                          desc: 'Azure VM id created' },
      { name: 'audit_log_url',  type: 'url',                             desc: 'Azure Activity Log reference' },
      { name: 'fulfil_status',  type: 'enum<success|failed>',            desc: 'Outcome' },
      { name: 'missing_fields', type: 'string[]',                        desc: 'Mandatory fields the RITM is missing' },
      { name: 'decision',       type: 'enum<success|missing|failed>',    desc: 'Routing decision' },
      { name: 'summary',        type: 'markdown',                        desc: 'Human-readable result' },
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

// v4: L1 Triage and AWS Agent now have multi-mode prompts (RITM fulfilment +
// CHG flow); ServiceNow Agent's outputs were renamed (chg_number →
// ticket_number); a new Azure Agent ships in the roster. Bumped from v3 so
// users get the updated defaults without needing to manually reset.
const STORAGE_KEY = 'hive.agents.v4'

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
