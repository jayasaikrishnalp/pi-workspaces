import { useEffect, useMemo, useState } from 'react'

import { useApi } from '../../hooks/useApi'
import {
  wikiStats, wikiDocs, wikiDoc, wikiSearch,
  type WikiDocSummary, type WikiDocFull, type WikiSearchHit,
} from '../../lib/api'

export function KnowledgeBaseScreen(): JSX.Element {
  const stats = useApi('wiki.stats', wikiStats)
  const list = useApi('wiki.docs', () => wikiDocs({ limit: 1000 }))
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<WikiSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  // Debounced search
  useEffect(() => {
    if (!q.trim()) { setHits(null); setSearchErr(null); return }
    const handle = window.setTimeout(() => {
      setSearching(true); setSearchErr(null)
      wikiSearch(q.trim(), 20)
        .then((r) => setHits(r.results))
        .catch((e: Error) => setSearchErr(e.message))
        .finally(() => setSearching(false))
    }, 200)
    return () => window.clearTimeout(handle)
  }, [q])

  const grouped = useMemo(() => groupByPrefix(list.data?.docs ?? []), [list.data?.docs])

  return (
    <div className="kb-screen" data-testid="knowledge-base">
      <div className="kb-header">
        <h2>Knowledge Base</h2>
        <div className="kb-meta">
          {stats.data ? (
            stats.data.configured ? (
              <>
                <strong>{stats.data.count}</strong> docs ·{' '}
                <code>{stats.data.root}</code>
                {stats.data.lastIngestAt ? ` · last ingest ${formatAgo(stats.data.lastIngestAt)}` : ''}
              </>
            ) : (
              <span style={{ color: 'var(--fg-muted, #888)' }}>
                wiki not configured — set <code>WIKI_ROOT</code> env var to a folder of markdown files.
              </span>
            )
          ) : 'loading…'}
        </div>
      </div>

      <div style={{ padding: '8px 16px' }}>
        <input
          className="input"
          placeholder="Search WK runbooks (e.g. GHO-IAC backup, AWS account cleanup)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="wiki-search-input"
          style={{ width: '100%', maxWidth: 600 }}
        />
        {searching ? <div className="dash-empty" style={{padding:'4px 0'}}>searching…</div> : null}
        {searchErr ? <div className="chat-msg-error">{searchErr}</div> : null}
      </div>

      <div className="kb-2col">
        <div className="kb-list" data-testid="wiki-list">
          {hits ? (
            hits.length === 0 ? (
              <div className="dash-empty">no matches for "{q}"</div>
            ) : (
              hits.map((h) => (
                <button
                  key={h.path}
                  className={`kb-list-row ${selected === h.path ? 'active' : ''}`}
                  onClick={() => setSelected(h.path)}
                  data-testid={`wiki-hit-${h.path}`}
                >
                  <div className="kb-list-name">{h.title}</div>
                  <div className="kb-list-desc" dangerouslySetInnerHTML={{ __html: h.snippet }} />
                  <div className="kb-list-desc" style={{opacity:0.6,fontFamily:'monospace',fontSize:11}}>{h.path}</div>
                </button>
              ))
            )
          ) : list.data?.docs.length === 0 ? (
            <div className="dash-empty">no docs indexed</div>
          ) : (
            grouped.map(([groupName, docs]) => (
              <div key={groupName}>
                <div style={{ padding: '8px 12px 4px', fontSize: 11, textTransform: 'uppercase', opacity: 0.5 }}>
                  {groupName} · {docs.length}
                </div>
                {docs.slice(0, 50).map((d) => (
                  <button
                    key={d.path}
                    className={`kb-list-row ${selected === d.path ? 'active' : ''}`}
                    onClick={() => setSelected(d.path)}
                    data-testid={`wiki-doc-${d.path}`}
                  >
                    <div className="kb-list-name">{d.title}</div>
                    <div className="kb-list-desc" style={{opacity:0.6,fontFamily:'monospace',fontSize:11}}>{d.path}</div>
                  </button>
                ))}
                {docs.length > 50 ? (
                  <div className="dash-empty" style={{padding:'4px 12px',fontSize:11}}>+{docs.length - 50} more (use search)</div>
                ) : null}
              </div>
            ))
          )}
        </div>
        <div className="kb-detail-pane">
          {selected ? <DocDetail path={selected} onClose={() => setSelected(null)} />
            : <div className="dash-empty">Select a doc on the left.</div>}
        </div>
      </div>
    </div>
  )
}

function DocDetail({ path, onClose }: { path: string; onClose: () => void }): JSX.Element {
  const [doc, setDoc] = useState<WikiDocFull | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setDoc(null); setErr(null)
    wikiDoc(path).then((d) => { if (!cancelled) setDoc(d) }).catch((e: Error) => { if (!cancelled) setErr(e.message) })
    return () => { cancelled = true }
  }, [path])
  return (
    <div className="kb-editor" data-testid={`wiki-detail-${path}`}>
      <div className="kb-editor-head">
        <h3>{doc?.title ?? path}</h3>
        <button className="btn btn-ghost" onClick={onClose}>×</button>
      </div>
      {err ? <div className="chat-msg-error">{err}</div> : null}
      {!doc ? <div className="dash-empty">loading…</div> : (
        <>
          <div style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.6, marginBottom: 12 }}>{doc.path}</div>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', margin: 0 }}>{doc.body}</pre>
        </>
      )}
    </div>
  )
}

function groupByPrefix(docs: WikiDocSummary[]): Array<[string, WikiDocSummary[]]> {
  const groups = new Map<string, WikiDocSummary[]>()
  for (const d of docs) {
    const slash = d.path.indexOf('/')
    const key = slash === -1 ? '(root)' : d.path.slice(0, slash) + '/'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(d)
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === '(root)') return -1
    if (b === '(root)') return 1
    return a.localeCompare(b)
  })
}

function formatAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
