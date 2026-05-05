/**
 * Tiny fetch wrapper. Cookies are sent automatically (`credentials: 'include'`).
 * The Vite dev server proxies /api to the workspace; in production the operator
 * serves web/dist behind the same origin.
 */

export interface ApiError {
  status: number
  code: string
  message: string
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body: unknown = null
  if (text.length > 0) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  if (!res.ok) {
    const err: ApiError = {
      status: res.status,
      code: (body as { error?: { code?: string } })?.error?.code ?? 'UNKNOWN',
      message: (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`,
    }
    throw err
  }
  return body as T
}

export async function login(token: string): Promise<void> {
  await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ token }) })
}

export async function checkAuth(): Promise<boolean> {
  try {
    await api('/api/auth/check')
    return true
  } catch {
    return false
  }
}

export async function getProbe(): Promise<{
  pi: { ok: boolean; error?: string }
  confluence: { ok: boolean; configured: boolean; error?: string }
  skills: { count: number }
  auth: { piAuthJsonPresent: boolean }
  workspace: { skillsDir: string; runsDir: string }
}> {
  return api('/api/probe')
}

export async function createSession(): Promise<string> {
  const r = await api<{ sessionKey: string }>('/api/sessions', { method: 'POST' })
  return r.sessionKey
}

export async function sendPrompt(sessionKey: string, message: string): Promise<string> {
  const r = await api<{ runId: string }>('/api/send-stream', {
    method: 'POST',
    body: JSON.stringify({ sessionKey, message }),
  })
  return r.runId
}

export async function getKbGraph(): Promise<{
  nodes: Array<{ id: string; name: string; description?: string }>
  edges: Array<{ source: string; target: string; kind: string }>
  diagnostics: Array<{ path: string; severity: string; message: string }>
}> {
  return api('/api/kb/graph')
}

export async function getKbSkill(name: string): Promise<{
  name: string
  frontmatter: Record<string, unknown>
  body: string
  path: string
}> {
  return api(`/api/kb/skill/${encodeURIComponent(name)}`)
}

export async function abortRun(runId: string): Promise<void> {
  await api(`/api/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST' })
}
