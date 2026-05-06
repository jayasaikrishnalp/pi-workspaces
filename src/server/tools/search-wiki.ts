/**
 * Built-in search-wiki tool. Surfaced to agents alongside MCP tools and via
 * a direct HTTP route. Also called as a pre-flight context injector by
 * send-stream so the LLM gets relevant runbook snippets for free.
 */
import type { WikiStore, WikiSearchHit } from '../wiki-store.js'

export interface SearchWikiResult {
  results: WikiSearchHit[]
  source: string
  query: string
}

export const SEARCH_WIKI_TOOL = {
  name: 'search-wiki',
  description:
    'Search the WK pipeline knowledge base (GHCOS repos, IAC pipelines, AI platform, runbooks). ' +
    'Use for "how do I…", "which pipeline…", "what does X do" questions about WK operations. ' +
    'Returns the top matching wiki pages with highlighted snippets and citation paths.',
  inputSchema: {
    type: 'object' as const,
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search terms — keywords, repo names, pipeline IDs.' },
      limit: { type: 'integer', description: 'Max hits (1–20).', default: 5, minimum: 1, maximum: 20 },
    },
  },
}

export function searchWiki(store: WikiStore, query: string, limit = 5): SearchWikiResult {
  const results = store.search(query, limit)
  return { results, source: 'pipeline-information/wiki', query }
}

/**
 * Build a single system-style context block from the top hits, ready to be
 * prepended to a chat prompt. Returns '' when there are no relevant hits.
 *
 * BM25 scores are negative — lower (more negative) = better match. We accept
 * any hit by default; the floor cuts off near-zero scores which mean barely
 * any term matched.
 */
export function buildWikiContext(
  hits: WikiSearchHit[],
  opts: { maxChars?: number; floor?: number } = {},
): string {
  const maxChars = opts.maxChars ?? 4000
  const floor = opts.floor ?? -0.1 // hits at -0.05 etc. are noise
  const good = hits.filter((h) => h.score < floor)
  if (good.length === 0) return ''

  const lines: string[] = [
    '## Relevant runbook context (auto-retrieved from pipeline-information/wiki)',
    '',
    'These pages were matched against your message. Cite by path; ignore if off-topic.',
    '',
  ]
  let used = lines.join('\n').length
  for (const h of good) {
    const block =
      `### ${h.title}  ·  \`${h.path}\`\n` +
      `${stripMark(h.snippet)}\n`
    if (used + block.length > maxChars) break
    lines.push(block)
    used += block.length
  }
  return lines.join('\n')
}

function stripMark(s: string): string {
  return s.replace(/<\/?mark>/g, '')
}
