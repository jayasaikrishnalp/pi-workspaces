/**
 * Typed fetch clients for the cloudops-workspace backend.
 *
 * All endpoints are cookie-gated. fetch defaults to `credentials: 'same-origin'`,
 * which works against the Vite proxy in dev and the same-origin static assets
 * in preview/production. On 401, callers can prompt for the dev token via
 * /api/auth/login.
 */

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  const text = await res.text()
  let parsed: unknown = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* keep null */ }
  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string; details?: unknown } })?.error
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `${method} ${path} failed (${res.status})`, err?.details)
  }
  return parsed as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}

/* ===== Probe ===== */

export interface ProbeResponse {
  pi: { ok: boolean; version?: string; latencyMs?: number; error?: string; activeProvider: string | null; activeModel: string | null }
  confluence: { ok: boolean; configured: boolean; error?: string }
  skills: { count: number }
  agents: { count: number }
  workflows: { count: number }
  memory: { count: number }
  souls?: { count: number }
  jobs?: { count: number }
  tasks?: { count: number; byStatus?: Record<string, number> }
  terminal?: { count: number }
  db?: { ok: boolean; schemaVersion?: number }
  mcp?: { servers: Array<{ id: string; kind: string; status: string; toolCount: number; error?: string }> }
  auth: { piAuthJsonPresent: boolean }
  wiki?: { configured: boolean; root: string | null; count: number; lastIngestAt: number | null }
  workspace: { kbRoot: string; skillsDir: string; runsDir: string }
}

export interface WikiDocSummary { path: string; title: string; updated_at: number }
export interface WikiDocFull {
  path: string
  title: string
  body: string
  frontmatter: string | null
  updated_at: number
  ingested_at: number
}
export interface WikiSearchHit { path: string; title: string; snippet: string; score: number }

export const wikiStats = () => api.get<{ configured: boolean; root: string | null; count: number; lastIngestAt: number | null }>('/api/wiki/stats')
export const wikiDocs = (params: { prefix?: string; limit?: number; offset?: number } = {}) => {
  const qs = new URLSearchParams()
  if (params.prefix) qs.set('prefix', params.prefix)
  if (params.limit != null) qs.set('limit', String(params.limit))
  if (params.offset != null) qs.set('offset', String(params.offset))
  const q = qs.toString()
  return api.get<{ docs: WikiDocSummary[] }>(`/api/wiki/docs${q ? '?' + q : ''}`)
}
export const wikiDoc = (path: string) => api.get<WikiDocFull>(`/api/wiki/doc?path=${encodeURIComponent(path)}`)
export const wikiSearch = (q: string, limit = 10) =>
  api.post<{ results: WikiSearchHit[]; source: string; query: string }>('/api/wiki/search', { q, limit })
export const wikiReindex = () =>
  api.post<{ count: number; durationMs: number; lastIngestAt: number | null }>('/api/wiki/reindex', {})

export const probe = () => api.get<ProbeResponse>('/api/probe')

/* ===== Jobs ===== */

export interface Job {
  id: string
  soul_id: string | null
  agent_id: string | null
  run_id: string | null
  session_id: string | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  title: string | null
  source: 'operator' | 'agent' | 'cron'
  created_at: number
  started_at: number | null
  completed_at: number | null
  summary: string | null
  error: string | null
}

export const listJobs = (params?: { status?: string; limit?: number }) => {
  const qs = new URLSearchParams()
  if (params?.status) qs.set('status', params.status)
  if (params?.limit) qs.set('limit', String(params.limit))
  return api.get<{ jobs: Job[] }>(`/api/jobs${qs.toString() ? '?' + qs : ''}`)
}

export const getJob = (id: string) => api.get<Job>(`/api/jobs/${encodeURIComponent(id)}`)

export const cancelJob = (id: string) => api.post<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`)

/* ===== Tasks ===== */

export interface Task {
  id: string
  title: string
  body: string | null
  status: 'triage' | 'todo' | 'ready' | 'running' | 'blocked' | 'done' | 'archived'
  priority: number
  source: 'operator' | 'agent'
  assignee_soul_id: string | null
  parent_task_id: string | null
  linked_job_id: string | null
  created_by: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  result: string | null
  idempotency_key: string | null
}

export const listTasks = (params?: { status?: string; source?: string; limit?: number }) => {
  const qs = new URLSearchParams()
  if (params?.status) qs.set('status', params.status)
  if (params?.source) qs.set('source', params.source)
  if (params?.limit) qs.set('limit', String(params.limit))
  return api.get<{ tasks: Task[] }>(`/api/tasks${qs.toString() ? '?' + qs : ''}`)
}

export const createTask = (body: Partial<Task>) => api.post<Task>('/api/tasks', body)
export const updateTask = (id: string, patch: Partial<Task>) => api.put<Task>(`/api/tasks/${encodeURIComponent(id)}`, patch)
export const deleteTask = (id: string) => api.delete<Task>(`/api/tasks/${encodeURIComponent(id)}`)

/* ===== KB graph ===== */

export interface SkillNode {
  id: string
  name: string
  description?: string
  tags?: string[]
  path: string
  source: 'skill' | 'agent' | 'workflow' | 'soul'
}

export interface SkillEdge {
  source: string
  target: string
  kind: 'uses' | 'link' | 'composes' | 'step' | 'embodies'
}

export interface KbGraph {
  nodes: SkillNode[]
  edges: SkillEdge[]
  diagnostics: Array<{ path: string; severity: 'error' | 'warn'; message: string }>
}

export const getKbGraph = () => api.get<KbGraph>('/api/kb/graph')

export interface KbDetail {
  name: string
  source: string
  path: string
  frontmatter: Record<string, unknown>
  body: string
  edges: SkillEdge[]
}

export const getKbSkill = (name: string) => api.get<KbDetail>(`/api/kb/skill/${encodeURIComponent(name)}`)

/* ===== Skills CRUD (POST/PUT) ===== */

export const createSkill = (input: { name: string; content?: string; frontmatter?: Record<string, unknown> }) =>
  api.post<{ name: string; path: string }>('/api/skills', input)
export const updateSkill = (name: string, patch: { content?: string; frontmatter?: Record<string, unknown> }) =>
  api.put<{ name: string; path: string }>(`/api/skills/${encodeURIComponent(name)}`, patch)

/* ===== Souls CRUD ===== */

export interface SoulInput {
  name: string
  description?: string
  values?: string[]
  priorities?: string[]
  decision_principles?: string[]
  tone?: string
  body?: string
}
export const listSouls = () => api.get<{ souls: Array<{ name: string; description?: string }> }>('/api/souls')
export const getSoul = (name: string) =>
  api.get<{ name: string; frontmatter: Record<string, unknown>; body: string; path: string }>(`/api/souls/${encodeURIComponent(name)}`)
export const createSoul = (input: SoulInput) => api.post<{ name: string; path: string }>('/api/souls', input)
export const updateSoul = (name: string, patch: Partial<SoulInput>) =>
  api.put<{ name: string; path: string }>(`/api/souls/${encodeURIComponent(name)}`, patch)

/* ===== Workflows CRUD ===== */

export interface WorkflowStep { kind: 'skill' | 'workflow'; ref: string }
export interface WorkflowSummary { name: string; description?: string; steps: WorkflowStep[] }
export interface WorkflowInput { name: string; description?: string; steps: WorkflowStep[] }

export const listWorkflows = () => api.get<{ workflows: WorkflowSummary[] }>('/api/workflows')
export const getWorkflow = (name: string) =>
  api.get<{ name: string; frontmatter: Record<string, unknown>; body: string; path: string }>(`/api/workflows/${encodeURIComponent(name)}`)
export const createWorkflow = (input: WorkflowInput) =>
  api.post<{ name: string; path: string }>('/api/workflows', input)
export const updateWorkflow = (name: string, patch: Partial<WorkflowInput>) =>
  api.put<{ name: string; path: string }>(`/api/workflows/${encodeURIComponent(name)}`, patch)

/* ===== Workflow runs (Conductor) ===== */
export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type WorkflowStepStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped'

export interface WorkflowRun {
  id: string
  workflow: string
  workflow_name: string | null
  status: WorkflowRunStatus
  started_at: number
  ended_at: number | null
  triggered_by: string | null
  step_count: number
  step_done: number
  error: string | null
}
export interface WorkflowStepRun {
  run_id: string
  step_index: number
  step_kind: 'skill' | 'workflow' | 'agent'
  step_ref: string
  status: WorkflowStepStatus
  started_at: number | null
  ended_at: number | null
  output: string | null
  error: string | null
  // v2 agent-driven columns:
  step_id: string | null
  step_agent_id: string | null
  step_note: string | null
  step_branches: string | null
  step_decision: string | null
  step_next: string | null
  pi_run_id: string | null
}

/** Body shape for POST /api/workflow-runs (server.ts).
 *  Re-exports the client-side Workflow + Agent types defined in
 *  workflows-store.ts / agents-store.ts. */
import type { Workflow as WfSchema } from './workflows-store'
import type { Agent as AgentSchema } from './agents-store'

export const listWorkflowRuns = (workflowId?: string) => {
  const qs = workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''
  return api.get<{ runs: WorkflowRun[] }>(`/api/workflow-runs${qs}`)
}
export const getWorkflowRun = (runId: string) =>
  api.get<{ run: WorkflowRun; steps: WorkflowStepRun[] }>(`/api/workflow-runs/${runId}`)
export const startWorkflowRun = (workflow: WfSchema, agents: AgentSchema[], triggeredBy = 'operator') =>
  api.post<{ runId: string }>(`/api/workflow-runs`, { workflow, agents, triggeredBy })
export const cancelWorkflowRun = (runId: string) =>
  api.post<{ ok: boolean }>(`/api/workflow-runs/${runId}/cancel`, {})
export const workflowRunEventsUrl = (runId: string) =>
  `/api/workflow-runs/${runId}/events`

/* ===== Dashboard intelligence ===== */

export interface DashboardIntelligence {
  windowDays: number
  sessionsCount: number
  apiCallsCount: number
  tokenTotals: { input: number; output: number; cacheRead: number; cacheWrite: number }
  topModels: Array<{ model: string; tokens: number; sessions: number; costUsd: number }>
  cacheContribution: number
  usageTrend: Array<{ bucket: string; tokensTotal: number; cacheRead: number; cost: number; topTool: string | null }>
  sessionsIntelligence: Array<{
    sessionId: string; title: string; msgCount: number; toolCount: number;
    tokensTotal: number; costUsd: number; predominantModel: string | null;
    lastActivityAt: number | null; agoText: string;
    tags: Array<'STALE' | 'TOOL_HEAVY' | 'HIGH_TOKEN'>
  }>
  hourOfDayHistogram: Array<{ hourUtc: number; count: number; tokens: number }>
  tokenMix: { input: number; output: number; cacheRead: number; cacheWrite: number }
  topTools: Array<{ tool: string; count: number }>
  activeModel: string | null
}

export const fetchDashboardIntelligence = (windowDays: number) =>
  api.get<DashboardIntelligence>(`/api/dashboard/intelligence?window=${windowDays}d`)

/* ===== Sessions ===== */

export interface SessionInfo { sessionKey: string; createdAt: number; title?: string }
export const listSessions = () => api.get<{ sessions: SessionInfo[] }>('/api/sessions')
export const createSession = () => api.post<{ sessionKey: string }>('/api/sessions')
export const setSessionTitle = (sessionKey: string, title: string) =>
  api.put<{ title: string | null }>(`/api/sessions/${encodeURIComponent(sessionKey)}/title`, { title })

/* ===== Secrets (Phase 2/4) ===== */
export interface SecretEntry { key: string; updatedAt: number }
export const listSecrets = () => api.get<{ secrets: SecretEntry[] }>('/api/secrets')
export const putSecret = (key: string, value: string) =>
  api.put<{ key: string; updatedAt: number }>(`/api/secrets/${encodeURIComponent(key)}`, { value })
export const deleteSecret = (key: string) =>
  api.delete<{ deleted: true }>(`/api/secrets/${encodeURIComponent(key)}`)

/* ===== Memory CRUD ===== */

export interface MemoryEntry { name: string; size: number; mtime: number }
export const listMemory = () => api.get<{ entries: MemoryEntry[] }>('/api/memory')
export const getMemory = (name: string) =>
  api.get<{ name: string; body: string; size: number; mtime: number }>(`/api/memory/${encodeURIComponent(name)}`)
export const writeMemory = (name: string, content: string) =>
  api.put<{ name: string; body: string; size: number; mtime: number }>(`/api/memory/${encodeURIComponent(name)}`, { content })

/* ===== Providers ===== */

export interface Provider {
  id: string; name: string; kind: 'oauth' | 'key' | 'local'
  status: 'configured' | 'unconfigured' | 'detected' | 'error'
  statusReason?: string; models: string[]
}
export const listProviders = () => api.get<{ providers: Provider[] }>('/api/providers')
export const getActiveProvider = () => api.get<{ providerId: string | null; modelId: string | null }>('/api/providers/active')
export const setActiveProvider = (providerId: string, modelId: string) =>
  api.put<{ providerId: string; modelId: string }>('/api/providers/active', { providerId, modelId })

/* ===== MCP ===== */

export interface McpServerStatus {
  id: string; kind: 'stdio' | 'http'
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  toolCount: number; error?: string; startedAt?: number
}
export interface QualifiedTool {
  serverId: string; toolName: string; qualifiedName: string
  description?: string; inputSchema: unknown
}
export const listMcpServers = (warm = false) =>
  api.get<{ servers: McpServerStatus[] }>(`/api/mcp/servers${warm ? '?warm=true' : ''}`)
export const listMcpTools = () => api.get<{ tools: QualifiedTool[] }>('/api/mcp/tools')

/* ===== Confluence ===== */

export interface ConfluenceHit { id: string; title: string; snippet?: string; url?: string }
export const searchConfluence = (query: string, limit = 10) =>
  api.post<{ hits: ConfluenceHit[] }>('/api/confluence/search', { query, limit })
export const getConfluencePage = (id: string) =>
  api.get<{ id: string; title: string; content: string; sourceUrl?: string }>(`/api/confluence/page/${encodeURIComponent(id)}`)

/* ===== Search (FTS5) ===== */

export interface SearchResult {
  kind: 'skill' | 'agent' | 'workflow' | 'memory' | 'soul' | 'chat'
  name?: string; runId?: string; messageId?: string
  snippet: string; score: number; path?: string
}
export const search = (q: string, opts?: { kind?: string; limit?: number }) => {
  const qs = new URLSearchParams({ q })
  if (opts?.kind) qs.set('kind', opts.kind)
  if (opts?.limit) qs.set('limit', String(opts.limit))
  return api.get<{ results: SearchResult[] }>(`/api/search?${qs}`)
}

/* ===== Terminal ===== */

export interface TerminalRow {
  id: string; command: string; cwd: string; exit_code: number | null
  stdout: string | null; stderr: string | null
  status: 'running' | 'completed' | 'timeout' | 'killed' | 'error'
  started_at: number; ended_at: number | null; duration_ms: number | null
}
export const execTerminal = (command: string, opts?: { cwd?: string; timeoutMs?: number }) =>
  api.post<{ id: string; status: TerminalRow['status']; exitCode: number | null; stdout: string; stderr: string; durationMs: number }>(
    '/api/terminal/exec', { command, ...opts },
  )
export const listTerminalExecutions = (limit = 50) =>
  api.get<{ executions: TerminalRow[] }>(`/api/terminal/executions?limit=${limit}`)

/* ===== Auth ===== */

export const login = (token: string) => api.post<{ ok: true }>('/api/auth/login', { token })
export const logout = () => api.post<{ ok: true }>('/api/auth/logout')
export const checkAuth = () => api.get<{ ok: true }>('/api/auth/check')

/* ===== Health (public) ===== */

export const health = () => api.get<{ ok: true; version: string }>('/api/health')
