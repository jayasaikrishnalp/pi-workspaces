/**
 * WikiIngester — full + incremental ingest of the WK pipeline wiki into WikiStore.
 *
 * Walks <wikiRoot>/**\/*.md, parses YAML frontmatter (best-effort), derives a
 * title from frontmatter.title or the first H1, and upserts into wiki_docs +
 * wiki_fts.
 */
import fs from 'node:fs'
import path from 'node:path'

import type { WikiStore } from './wiki-store.js'

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/
const H1_RE = /^#\s+(.+)$/m
const TITLE_RE = /^title:\s*(.+?)\s*$/m

export class WikiIngester {
  constructor(private store: WikiStore, private root: string) {}

  /** Walk the entire wiki and (re-)ingest every .md file. Idempotent. */
  async ingestAll(): Promise<{ count: number; durationMs: number }> {
    const t0 = Date.now()
    if (!fs.existsSync(this.root)) {
      return { count: 0, durationMs: 0 }
    }
    let count = 0
    for (const abs of walkMarkdown(this.root)) {
      try {
        this.ingestFile(abs)
        count++
      } catch (err) {
        console.warn('[wiki-ingester]', abs, (err as Error).message)
      }
    }
    return { count, durationMs: Date.now() - t0 }
  }

  /** Ingest a single absolute path. Used by the watcher for change events. */
  ingestFile(absPath: string): void {
    const rel = path.relative(this.root, absPath).split(path.sep).join('/')
    if (!rel || rel.startsWith('..')) return
    if (!rel.endsWith('.md')) return

    let raw = ''
    let mtime = Date.now()
    try {
      raw = fs.readFileSync(absPath, 'utf8')
      mtime = fs.statSync(absPath).mtimeMs
    } catch {
      return
    }

    const m = FRONTMATTER_RE.exec(raw)
    const frontmatter = m ? m[1] : null
    const body = m ? raw.slice(m[0].length) : raw

    let title: string | undefined
    if (frontmatter) {
      const t = TITLE_RE.exec(frontmatter)
      if (t) title = stripQuotes(t[1]!)
    }
    if (!title) {
      const h = H1_RE.exec(body)
      if (h) title = h[1]!.trim()
    }
    if (!title) title = path.basename(rel, '.md')

    this.store.upsert({ path: rel, title, body, frontmatter, mtime })
  }

  /** Mirror of ingestFile for delete events. */
  removeFile(absPath: string): void {
    const rel = path.relative(this.root, absPath).split(path.sep).join('/')
    if (!rel || rel.startsWith('..')) return
    this.store.delete(rel)
  }
}

function* walkMarkdown(root: string): Generator<string> {
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        // Skip the graphify-out artifact dir and any node_modules.
        if (e.name === 'graphify-out' || e.name === 'node_modules') continue
        stack.push(abs)
      } else if (e.isFile() && e.name.endsWith('.md')) {
        yield abs
      }
    }
  }
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, '')
}
