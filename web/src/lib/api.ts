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

/* ===== Auth ===== */

export const login = (token: string) => api.post<{ ok: true }>('/api/auth/login', { token })
export const logout = () => api.post<{ ok: true }>('/api/auth/logout')
export const checkAuth = () => api.get<{ ok: true }>('/api/auth/check')

/* ===== Health (public) ===== */

export const health = () => api.get<{ ok: true; version: string }>('/api/health')
