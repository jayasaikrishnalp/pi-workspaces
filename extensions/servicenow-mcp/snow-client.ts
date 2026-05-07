/**
 * Thin REST wrapper around ServiceNow's Table API + a couple of helpers.
 * Reads SNOW_INSTANCE / SNOW_USER / SNOW_PASS from env at every call —
 * never caches creds — so a workspace secret rotation lands on the next
 * tool call without restarting the server.
 *
 * The instance can be either "company.service-now.com" or a full URL
 * "https://company.service-now.com" — both are normalized.
 */

export interface SnowEnv {
  instance: string
  user: string
  pass: string
}

export class SnowError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number, public readonly body?: unknown) {
    super(message)
  }
}

/** Read + validate env at call time. Throws SnowError('NO_CREDS') when any
 *  of the three required env vars is missing. */
export function readEnv(env: NodeJS.ProcessEnv = process.env): SnowEnv {
  const instance = (env.SNOW_INSTANCE ?? '').trim()
  const user = (env.SNOW_USER ?? '').trim()
  const pass = (env.SNOW_PASS ?? '').trim()
  if (!instance || !user || !pass) {
    throw new SnowError(
      'NO_CREDS',
      'SNOW_INSTANCE / SNOW_USER / SNOW_PASS not set in env. ' +
      'Add them via the Hive Secrets screen, then retry.',
    )
  }
  return { instance, user, pass }
}

/** Resolve "company.service-now.com" or full URL → "https://…/api/now". */
export function baseUrl(env: SnowEnv): string {
  let host = env.instance
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`
  return host.replace(/\/+$/, '') + '/api/now'
}

function authHeader(env: SnowEnv): string {
  // Prefer Buffer in Node; fall back to btoa for tooling.
  const raw = `${env.user}:${env.pass}`
  if (typeof Buffer !== 'undefined') return 'Basic ' + Buffer.from(raw, 'utf8').toString('base64')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return 'Basic ' + (globalThis as any).btoa(raw)
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** Pass display values for coded fields ("Resolved" not "6"). Default true. */
  display?: boolean
  /** Override env (mostly for tests). */
  env?: SnowEnv
}

export async function snowRequest<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const env = opts.env ?? readEnv()
  const url = new URL(baseUrl(env) + (path.startsWith('/') ? path : '/' + path))
  const display = opts.display ?? true
  if (display) url.searchParams.set('sysparm_display_value', 'true')
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: {
      'Authorization': authHeader(env),
      'Accept': 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  }
  let res: Response
  try {
    res = await fetch(url.toString(), init)
  } catch (err) {
    throw new SnowError('NETWORK', `network error to ${url.host}: ${(err as Error).message}`)
  }
  const text = await res.text()
  let parsed: unknown = text
  try { parsed = text ? JSON.parse(text) : null } catch { /* keep as text */ }
  if (!res.ok) {
    const errMsg = (parsed && typeof parsed === 'object' && 'error' in parsed && parsed.error && typeof parsed.error === 'object' && 'message' in parsed.error)
      ? String((parsed as { error: { message: string } }).error.message)
      : res.statusText
    throw new SnowError('HTTP_' + res.status, `${res.status} ${errMsg} on ${opts.method ?? 'GET'} ${url.pathname}`, res.status, parsed)
  }
  return parsed as T
}

/** Slim a SNOW Table API record by stripping the link sentinels and keeping
 *  display_values when sysparm_display_value=true was passed. SNOW returns
 *  every reference field as either a primitive or `{display_value, link, value}`;
 *  we collapse to just the strings the caller cares about. */
export function flatten(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rec)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as { display_value?: unknown; value?: unknown; link?: unknown }
      if ('display_value' in o || 'value' in o || 'link' in o) {
        out[k] = {
          display_value: o.display_value ?? null,
          value: o.value ?? null,
        }
        continue
      }
    }
    out[k] = v
  }
  return out
}
