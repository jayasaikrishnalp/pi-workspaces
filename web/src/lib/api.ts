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
  workspace: { kbRoot: string; skillsDir: string; runsDir: string }
}

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
