/**
 * WikiStore — thin wrapper over the SQLite wiki_docs + wiki_fts tables.
 * Source: /Users/.../pipeline-information/wiki/, populated by WikiIngester.
 */
import type { Db } from './db.js'

export interface WikiDoc {
  path: string
  title: string
  body: string
  frontmatter: string | null
  updated_at: number
  ingested_at: number
}

export interface WikiSearchHit {
  path: string
  title: string
  snippet: string
  score: number
}

export class WikiStore {
  constructor(private db: Db) {}

  upsert(doc: { path: string; title: string; body: string; frontmatter?: string | null; mtime: number }): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM wiki_docs WHERE path = ?').run(doc.path)
      this.db.prepare('DELETE FROM wiki_fts WHERE path = ?').run(doc.path)
      this.db.prepare(
        'INSERT INTO wiki_docs (path, title, body, frontmatter, updated_at, ingested_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(doc.path, doc.title, doc.body, doc.frontmatter ?? null, doc.mtime, Date.now())
      this.db.prepare(
        'INSERT INTO wiki_fts (path, title, body) VALUES (?, ?, ?)',
      ).run(doc.path, doc.title, doc.body)
    })
    tx()
  }

  delete(path: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM wiki_docs WHERE path = ?').run(path)
      this.db.prepare('DELETE FROM wiki_fts WHERE path = ?').run(path)
    })
    tx()
  }

  clear(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM wiki_docs').run()
      this.db.prepare('DELETE FROM wiki_fts').run()
    })
    tx()
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM wiki_docs').get() as { c: number }
    return row.c
  }

  lastIngestAt(): number | null {
    const row = this.db.prepare('SELECT MAX(ingested_at) AS t FROM wiki_docs').get() as { t: number | null }
    return row.t
  }

  list(opts: { prefix?: string; limit?: number; offset?: number } = {}): Array<Pick<WikiDoc, 'path' | 'title' | 'updated_at'>> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
    const offset = Math.max(opts.offset ?? 0, 0)
    if (opts.prefix) {
      return this.db.prepare(
        'SELECT path, title, updated_at FROM wiki_docs WHERE path LIKE ? ORDER BY path LIMIT ? OFFSET ?',
      ).all(opts.prefix + '%', limit, offset) as Array<Pick<WikiDoc, 'path' | 'title' | 'updated_at'>>
    }
    return this.db.prepare(
      'SELECT path, title, updated_at FROM wiki_docs ORDER BY path LIMIT ? OFFSET ?',
    ).all(limit, offset) as Array<Pick<WikiDoc, 'path' | 'title' | 'updated_at'>>
  }

  get(path: string): WikiDoc | null {
    const row = this.db.prepare('SELECT * FROM wiki_docs WHERE path = ?').get(path) as WikiDoc | undefined
    return row ?? null
  }

  /**
   * FTS5 BM25 search. Returns ranked hits with highlighted snippets.
   * Caller must sanitize the query — we wrap with a permissive fallback
   * so syntax errors return zero hits instead of throwing.
   */
  search(query: string, limit = 5): WikiSearchHit[] {
    const q = sanitizeFtsQuery(query)
    if (!q) return []
    const cap = Math.min(Math.max(limit, 1), 50)
    try {
      return this.db.prepare(`
        SELECT path, title,
               snippet(wiki_fts, 2, '<mark>', '</mark>', '…', 16) AS snippet,
               bm25(wiki_fts) AS score
        FROM wiki_fts
        WHERE wiki_fts MATCH ?
        ORDER BY score
        LIMIT ?
      `).all(q, cap) as WikiSearchHit[]
    } catch (err) {
      console.warn('[wiki-store] search failed:', (err as Error).message, 'query=', q)
      return []
    }
  }
}

/**
 * FTS5 query syntax is strict (operators: AND OR NOT NEAR + quoting).
 * Operator-bearing user input throws. We split on whitespace, drop short
 * tokens, escape internal quotes, and OR them together so any-term-matches.
 */
function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 2 && !FTS_RESERVED.has(t))
  if (tokens.length === 0) return ''
  return tokens.map((t) => `"${t}"*`).join(' OR ')
}

const FTS_RESERVED = new Set(['and', 'or', 'not', 'near'])
