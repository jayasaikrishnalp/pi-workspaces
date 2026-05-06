import type { Db } from './db.js'

export type SearchKind = 'skill' | 'agent' | 'workflow' | 'memory' | 'soul' | 'chat'

export interface SearchResult {
  kind: SearchKind
  name?: string                  // present for kb-* kinds
  runId?: string                 // present for chat
  messageId?: string             // present for chat
  snippet: string
  score: number
  path?: string                  // present for kb-* kinds
}

/**
 * Sanitize a user-supplied query for FTS5's MATCH syntax.
 *
 * SQLite FTS5 cannot be parameterized at the MATCH level — the query string
 * is interpreted by the FTS engine. So we either parameterize the *whole*
 * query as a single quoted phrase (which kills useful features like prefix
 * matching) or we accept ad-hoc input and sanitize it.
 *
 * Adapted from Hermes's `_sanitize_fts5_query` (hermes_state.py). The
 * approach: walk character by character, balance double-quotes, escape FTS5
 * specials (`(`, `)`, `*`, `:`, `^`) outside of quoted phrases.
 *
 * Rejects empty queries with `null` so callers can return 400 INVALID_QUERY.
 */
const FTS_SPECIALS = new Set(['(', ')', '*', ':', '^'])

export function sanitizeFtsQuery(raw: string): string | null {
  if (typeof raw !== 'string') return null
  let q = raw.trim()
  if (q.length === 0) return null

  // First pass: strip every character that isn't a letter / digit / space / safe punct.
  // We allow letters, digits, spaces, hyphens, underscores, dots, commas, and quotes.
  // Anything else gets replaced with a space so MATCH treats them as separators.
  let out = ''
  let inQuote = false
  for (const ch of q) {
    if (ch === '"') {
      out += ch
      inQuote = !inQuote
      continue
    }
    if (FTS_SPECIALS.has(ch)) {
      // Outside quotes: replace with space; inside quotes: drop entirely.
      out += inQuote ? '' : ' '
      continue
    }
    out += ch
  }
  // Drop the unmatched trailing quote if the user typed an odd number.
  if (inQuote) {
    out = out.replace(/"([^"]*)$/, '$1')
  }
  out = out.replace(/\s+/g, ' ').trim()
  if (out.length === 0) return null
  return out
}

interface SearchOpts {
  kinds?: ReadonlySet<SearchKind>
  limit?: number
}

const ALL_KINDS: ReadonlySet<SearchKind> = new Set(['skill', 'agent', 'workflow', 'memory', 'soul', 'chat'])

const KB_KINDS: ReadonlySet<SearchKind> = new Set(['skill', 'agent', 'workflow', 'memory', 'soul'])

/**
 * Run search across kb_fts (markdown bodies) and chat_fts (chat messages).
 * Unions results from unicode61 and trigram indexes, dedupes by
 * `(kind, rowid)` keeping the higher score.
 */
export function search(db: Db, q: string, opts: SearchOpts = {}): SearchResult[] {
  const sanitized = sanitizeFtsQuery(q)
  if (!sanitized) return []
  const kinds = opts.kinds ?? ALL_KINDS
  const limit = Math.max(1, Math.min(200, opts.limit ?? 20))

  type RawRow = { kind: SearchKind; name?: string; rowid: number; snippet: string; score: number; runId?: string; messageId?: string }
  const seen = new Map<string, RawRow>()

  const wantsKb = [...KB_KINDS].some((k) => kinds.has(k))
  if (wantsKb) {
    const allowed = [...kinds].filter((k) => KB_KINDS.has(k))
    const placeholders = allowed.map(() => '?').join(',')
    const sqlMain = `
      SELECT kind, name, rowid, snippet(kb_fts, 2, '<<', '>>', '...', 12) AS snippet, bm25(kb_fts) AS score
      FROM kb_fts
      WHERE kb_fts MATCH ?
        AND kind IN (${placeholders})
      ORDER BY score
      LIMIT ?
    `
    const sqlTri = `
      SELECT kind, name, rowid, snippet(kb_fts_trigram, 2, '<<', '>>', '...', 12) AS snippet, bm25(kb_fts_trigram) AS score
      FROM kb_fts_trigram
      WHERE kb_fts_trigram MATCH ?
        AND kind IN (${placeholders})
      ORDER BY score
      LIMIT ?
    `
    const main = safeAll<{ kind: string; name: string; rowid: number; snippet: string; score: number }>(
      db, sqlMain, [sanitized, ...allowed, limit],
    )
    const tri = safeAll<{ kind: string; name: string; rowid: number; snippet: string; score: number }>(
      db, sqlTri, [sanitized, ...allowed, limit],
    )
    for (const r of [...main, ...tri]) {
      const key = `kb:${r.kind}:${r.name}`
      const existing = seen.get(key)
      // Lower BM25 score = better match.
      if (!existing || r.score < existing.score) {
        seen.set(key, { kind: r.kind as SearchKind, name: r.name, rowid: r.rowid, snippet: r.snippet, score: r.score })
      }
    }
  }

  if (kinds.has('chat')) {
    const sqlMain = `
      SELECT m.id AS messageId, m.run_id AS runId, m.rowid AS rowid,
             snippet(chat_fts, 0, '<<', '>>', '...', 12) AS snippet,
             bm25(chat_fts) AS score
      FROM chat_fts JOIN chat_messages m ON m.rowid = chat_fts.rowid
      WHERE chat_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `
    const sqlTri = `
      SELECT m.id AS messageId, m.run_id AS runId, m.rowid AS rowid,
             snippet(chat_fts_trigram, 0, '<<', '>>', '...', 12) AS snippet,
             bm25(chat_fts_trigram) AS score
      FROM chat_fts_trigram JOIN chat_messages m ON m.rowid = chat_fts_trigram.rowid
      WHERE chat_fts_trigram MATCH ?
      ORDER BY score
      LIMIT ?
    `
    const main = safeAll<{ messageId: string; runId: string; rowid: number; snippet: string; score: number }>(
      db, sqlMain, [sanitized, limit],
    )
    const tri = safeAll<{ messageId: string; runId: string; rowid: number; snippet: string; score: number }>(
      db, sqlTri, [sanitized, limit],
    )
    for (const r of [...main, ...tri]) {
      const key = `chat:${r.messageId}`
      const existing = seen.get(key)
      if (!existing || r.score < existing.score) {
        seen.set(key, { kind: 'chat', rowid: r.rowid, snippet: r.snippet, score: r.score, runId: r.runId, messageId: r.messageId })
      }
    }
  }

  const results: SearchResult[] = [...seen.values()]
    .sort((a, b) => a.score - b.score) // lower BM25 = better
    .slice(0, limit)
    .map((r) => {
      const out: SearchResult = { kind: r.kind, snippet: r.snippet, score: r.score }
      if (r.name !== undefined) {
        out.name = r.name
        out.path = pathFor(r.kind, r.name)
      }
      if (r.runId) out.runId = r.runId
      if (r.messageId) out.messageId = r.messageId
      return out
    })
  return results
}

/**
 * Run a query and silently swallow FTS5 syntax errors (the sanitizer should
 * prevent these, but defense-in-depth).
 */
function safeAll<T>(db: Db, sql: string, params: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[]
  } catch {
    return []
  }
}

const KIND_TO_DIR: Record<string, string | null> = {
  skill: 'skills',
  agent: 'agents',
  workflow: 'workflows',
  memory: 'memory',
  soul: 'souls',
  chat: null,
}

const KIND_TO_FILENAME: Record<string, string | null> = {
  skill: 'SKILL.md',
  agent: 'AGENT.md',
  workflow: 'WORKFLOW.md',
  soul: 'SOUL.md',
  memory: null, // memory is <name>.md directly
  chat: null,
}

function pathFor(kind: SearchKind, name: string): string | undefined {
  const dir = KIND_TO_DIR[kind]
  if (!dir) return undefined
  if (kind === 'memory') return `${dir}/${name}.md`
  const filename = KIND_TO_FILENAME[kind]
  return filename ? `${dir}/${name}/${filename}` : undefined
}
