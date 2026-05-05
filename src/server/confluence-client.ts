import sanitizeHtml from 'sanitize-html'

/**
 * Workspace Confluence client. Implements the 10 hardening items from the
 * locked spec §Stage 5:
 *
 *   1. Allowlist BASE_URL
 *   2. Validate pageId as /^\d+$/
 *   3. Redact Atlassian raw error bodies
 *   4. Wrap page content in <external_content trusted="false">…</external_content>
 *   5. Accept ATLASSIAN_API_TOKEN, fallback JIRA_TOKEN
 *   6. AbortSignal.timeout(10s) on every outbound request
 *   7. Server-built CQL only — no client passthrough
 *   8. Clamp inputs (query, limit, maxChars)
 *   9. sanitize-html with a strict allowlist
 *  10. Normalized 401/403/429 + 5-min cache
 */

export const ALLOWED_BASE_URL = 'https://wkengineering.atlassian.net'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_CACHE_MAX = 256

const QUERY_MAX = 200
const LIMIT_MIN = 1
const LIMIT_MAX = 20
const LIMIT_DEFAULT = 5
const MAX_CHARS_MIN = 256
const MAX_CHARS_MAX = 16_000
const MAX_CHARS_DEFAULT = 8_000

const SANITIZE_ALLOWED_TAGS = [
  'p', 'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4',
  'code', 'pre', 'strong', 'em', 'br', 'blockquote',
] as const

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [...SANITIZE_ALLOWED_TAGS],
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  disallowedTagsMode: 'discard',
}

export interface ConfluenceClientOptions {
  baseUrl: string
  email: string
  apiToken: string
  cacheTtlMs?: number
  cacheMax?: number
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

export interface SearchHit {
  id: string
  title: string
  snippet: string
  url: string
}

export interface PageContent {
  id: string
  title: string
  content: string
  sourceUrl: string
}

export type ConfluenceErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_PAGE_ID'
  | 'INVALID_BASE_URL'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'EXTERNAL_API_ERROR'
  | 'TIMEOUT'
  | 'INTERNAL'

export class ConfluenceError extends Error {
  readonly code: ConfluenceErrorCode
  readonly status: number | null
  constructor(code: ConfluenceErrorCode, message: string, status: number | null = null) {
    super(message)
    this.code = code
    this.status = status
  }
}

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class ConfluenceClient {
  readonly configured: boolean
  private readonly baseUrl: string
  private readonly authHeader: string
  private readonly cacheTtl: number
  private readonly cacheMax: number
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly timeoutMs: number
  private cache = new Map<string, CacheEntry<unknown>>()

  constructor(opts: ConfluenceClientOptions) {
    if (opts.baseUrl !== ALLOWED_BASE_URL) {
      throw new ConfluenceError(
        'INVALID_BASE_URL',
        `CONFLUENCE_BASE_URL must be exactly ${ALLOWED_BASE_URL}; got ${JSON.stringify(opts.baseUrl)}`,
      )
    }
    if (!opts.email || !opts.apiToken) {
      throw new ConfluenceError(
        'INVALID_INPUT',
        'ConfluenceClient requires both email and apiToken',
      )
    }
    this.baseUrl = opts.baseUrl
    this.authHeader =
      'Basic ' + Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')
    this.cacheTtl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.cacheMax = opts.cacheMax ?? DEFAULT_CACHE_MAX
    this.fetchFn = opts.fetch ?? fetch
    this.now = opts.now ?? (() => Date.now())
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.configured = true
  }

  /** Search via server-built CQL. Plain text in, hits out. */
  async search(input: { query: string; limit?: number }): Promise<SearchHit[]> {
    const query = clampQuery(input.query)
    const limit = clampLimit(input.limit)
    const cacheKey = `search:${limit}:${query}`
    const cached = this.cacheGet<SearchHit[]>(cacheKey)
    if (cached) return cached

    const cql = buildCql(query)
    const url = new URL('/wiki/rest/api/content/search', this.baseUrl)
    url.searchParams.set('cql', cql)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('expand', 'space')

    const json = await this.requestJson<{ results: AtlassianSearchResult[] }>(url, {
      method: 'GET',
    })
    const hits: SearchHit[] = (json.results ?? []).map((r) => ({
      id: String(r.id ?? ''),
      title: typeof r.title === 'string' ? r.title : '',
      snippet: typeof r.excerpt === 'string' ? sanitizeForSnippet(r.excerpt) : '',
      url: r._links?.webui ? `${this.baseUrl}/wiki${r._links.webui}` : '',
    }))
    this.cacheSet(cacheKey, hits)
    return hits
  }

  async getPage(pageId: string, maxChars?: number): Promise<PageContent> {
    if (!/^\d+$/.test(pageId)) {
      throw new ConfluenceError('INVALID_PAGE_ID', `pageId must match /^\\d+$/; got ${JSON.stringify(pageId)}`)
    }
    const cap = clampMaxChars(maxChars)
    const cacheKey = `page:${pageId}:${cap}`
    const cached = this.cacheGet<PageContent>(cacheKey)
    if (cached) return cached

    const url = new URL(`/wiki/rest/api/content/${pageId}`, this.baseUrl)
    url.searchParams.set('expand', 'body.view,space')
    const json = await this.requestJson<AtlassianPage>(url, { method: 'GET' })

    const rawHtml = json.body?.view?.value ?? ''
    let sanitized = sanitizeHtml(rawHtml, SANITIZE_OPTS)
    let truncated = false
    if (sanitized.length > cap) {
      sanitized = sanitized.slice(0, cap)
      truncated = true
    }
    const wrapped =
      `<external_content trusted="false" source="confluence" page-id="${pageId}">` +
      sanitized +
      (truncated ? '\n…' : '') +
      `</external_content>`

    const result: PageContent = {
      id: pageId,
      title: typeof json.title === 'string' ? json.title : '',
      content: wrapped,
      sourceUrl: json._links?.webui ? `${this.baseUrl}/wiki${json._links.webui}` : '',
    }
    this.cacheSet(cacheKey, result)
    return result
  }

  // ---- internals ----------------------------------------------------------

  private async requestJson<T>(url: URL, init: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await this.fetchFn(url, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: this.authHeader,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        throw new ConfluenceError('TIMEOUT', `Atlassian request timed out after ${this.timeoutMs}ms`)
      }
      throw new ConfluenceError(
        'EXTERNAL_API_ERROR',
        `outbound fetch failed: ${(err as Error).message}`,
      )
    }

    if (response.ok) {
      try {
        return (await response.json()) as T
      } catch (err) {
        throw new ConfluenceError(
          'EXTERNAL_API_ERROR',
          `Atlassian returned non-JSON: ${(err as Error).message}`,
          response.status,
        )
      }
    }

    // Read the raw body for ops logging only — we DO NOT forward it.
    let rawBody = ''
    try {
      rawBody = await response.text()
    } catch {
      // ignore
    }
    if (rawBody.length > 0) {
      console.error(
        `[confluence-client] Atlassian ${response.status} for ${url.pathname}: ${rawBody.slice(0, 500)}`,
      )
    }
    throw mapHttpStatusToError(response.status)
  }

  private cacheGet<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expiresAt < this.now()) {
      this.cache.delete(key)
      return null
    }
    // LRU touch.
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value as T
  }

  private cacheSet<T>(key: string, value: T): void {
    if (this.cache.size >= this.cacheMax) {
      // Drop the oldest (first-inserted) entry.
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) this.cache.delete(oldestKey)
    }
    this.cache.set(key, { value, expiresAt: this.now() + this.cacheTtl })
  }
}

// ---- helpers --------------------------------------------------------------

function clampQuery(q: unknown): string {
  if (typeof q !== 'string' || q.length === 0) {
    throw new ConfluenceError('INVALID_INPUT', 'query must be a non-empty string')
  }
  if (q.length > QUERY_MAX) {
    throw new ConfluenceError('INVALID_INPUT', `query exceeds ${QUERY_MAX} characters`)
  }
  return q
}

function clampLimit(n: unknown): number {
  if (n === undefined) return LIMIT_DEFAULT
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new ConfluenceError('INVALID_INPUT', 'limit must be an integer')
  }
  if (n < LIMIT_MIN) return LIMIT_MIN
  if (n > LIMIT_MAX) return LIMIT_MAX
  return n
}

function clampMaxChars(n: unknown): number {
  if (n === undefined) return MAX_CHARS_DEFAULT
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new ConfluenceError('INVALID_INPUT', 'maxChars must be an integer')
  }
  if (n < MAX_CHARS_MIN) return MAX_CHARS_MIN
  if (n > MAX_CHARS_MAX) return MAX_CHARS_MAX
  return n
}

/**
 * Build a CQL string from plain user text. The text is escaped (`"` and `\`)
 * and wrapped in a quoted `text ~ "..."` clause. We intentionally do NOT allow
 * the caller to inject AND/OR/parens — the structure is fixed.
 */
export function buildCql(query: string): string {
  const escaped = query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `text ~ "${escaped}" AND space.type != "personal"`
}

function mapHttpStatusToError(status: number): ConfluenceError {
  if (status === 401) return new ConfluenceError('AUTH_REQUIRED', 'Atlassian rejected credentials', 401)
  if (status === 403) return new ConfluenceError('FORBIDDEN', 'Atlassian denied access to the resource', 403)
  if (status === 429) return new ConfluenceError('RATE_LIMITED', 'Atlassian rate-limited the request', 429)
  if (status >= 500) return new ConfluenceError('EXTERNAL_API_ERROR', `Atlassian ${status}`, status)
  return new ConfluenceError('EXTERNAL_API_ERROR', `Atlassian ${status}`, status)
}

function sanitizeForSnippet(s: string): string {
  // Search excerpts already strip HTML on the Atlassian side, but be defensive:
  // run a minimal sanitize-html with NO tags allowed, plus length cap.
  const text = sanitizeHtml(s, { allowedTags: [], allowedAttributes: {} })
  return text.length > 280 ? text.slice(0, 277) + '…' : text
}

interface AtlassianSearchResult {
  id?: string | number
  title?: string
  excerpt?: string
  _links?: { webui?: string }
}
interface AtlassianPage {
  id?: string | number
  title?: string
  body?: { view?: { value?: string } }
  _links?: { webui?: string }
}
