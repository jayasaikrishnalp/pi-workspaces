/**
 * /api/wiki-ui/* — static-file passthrough that serves the existing
 * llm-wiki-ui bundle (HTML/CSS/JS/JSON) so it can be embedded in the
 * Hive Knowledge Base screen via <iframe>. The directory is not part
 * of the repo — it lives at <wikiUiRoot> on disk (gitignored).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import fs from 'node:fs'

import { jsonError } from '../server/http-helpers.js'
import type { Wiring } from '../server/wiring.js'

export const WIKI_UI_PREFIX = '/api/wiki-ui/'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
}

function mimeFor(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream'
}

export async function handleWikiUi(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  if (!w.wikiUiRoot) {
    jsonError(res, 503, 'WIKI_UI_DISABLED', 'wiki-ui static root not configured')
    return
  }
  const reqUrl = req.url ?? ''
  // Strip the prefix and any querystring; decode URI components (handles
  // the "LLM Wiki.html" filename which contains a space).
  const afterPrefix = reqUrl.slice(WIKI_UI_PREFIX.length).split('?')[0] ?? ''
  let rel: string
  try {
    rel = decodeURIComponent(afterPrefix)
  } catch {
    jsonError(res, 400, 'BAD_PATH', 'invalid URI encoding')
    return
  }
  // Reject obvious traversal markers before resolving — keeps the error
  // path simple and makes the test for `..%2F..%2F` unambiguous.
  if (rel.includes('..') || rel.startsWith('/') || rel.includes('\0')) {
    jsonError(res, 400, 'BAD_PATH', 'path must not escape the wiki-ui root')
    return
  }
  const abs = path.resolve(w.wikiUiRoot, rel)
  // Defense-in-depth: even after the textual check, confirm the resolved
  // path stays inside wikiUiRoot.
  const rootResolved = path.resolve(w.wikiUiRoot)
  if (!abs.startsWith(rootResolved + path.sep) && abs !== rootResolved) {
    jsonError(res, 400, 'BAD_PATH', 'path escapes the wiki-ui root')
    return
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    jsonError(res, 404, 'NOT_FOUND', `wiki-ui asset not found: ${rel}`)
    return
  }
  if (!stat.isFile()) {
    jsonError(res, 404, 'NOT_FOUND', `wiki-ui asset not a file: ${rel}`)
    return
  }
  res.writeHead(200, {
    'Content-Type': mimeFor(abs),
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  })
  fs.createReadStream(abs).pipe(res)
}
