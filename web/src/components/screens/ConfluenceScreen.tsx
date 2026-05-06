import { useState } from 'react'
import { searchConfluence, getConfluencePage, type ConfluenceHit } from '../../lib/api'

export function ConfluenceScreen(): JSX.Element {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<ConfluenceHit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pageDetail, setPageDetail] = useState<{ id: string; title: string; content: string; sourceUrl?: string } | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!q.trim()) return
    setBusy(true); setError(null)
    try {
      const r = await searchConfluence(q, 10)
      setHits(r.hits)
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }

  const openPage = async (id: string) => {
    setError(null)
    try { setPageDetail(await getConfluencePage(id)) } catch (err) { setError((err as Error).message) }
  }

  return (
    <div className="kb-screen" data-testid="confluence">
      <div className="kb-header">
        <h2>Confluence</h2>
        <div className="kb-meta">search WK Confluence (cookie-gated · server-side rendering)</div>
      </div>
      <form className="terminal-form" onSubmit={submit} data-testid="confluence-form">
        <input className="input terminal-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="search query…" data-testid="confluence-input"/>
        <button className="btn btn-primary" type="submit" disabled={busy || !q.trim()} data-testid="confluence-search">{busy ? 'searching…' : 'search'}</button>
      </form>
      {error ? <div className="chat-msg-error" data-testid="confluence-error">{error}</div> : null}
      {hits ? (
        <div className="kb-2col">
          <div className="kb-list" data-testid="confluence-results">
            {hits.length === 0 ? <div className="dash-empty">no hits</div>
              : hits.map((h) => (
                  <button key={h.id} className="kb-list-row" onClick={() => openPage(h.id)} data-testid={`confluence-hit-${h.id}`}>
                    <div className="kb-list-name">{h.title}</div>
                    {h.snippet ? <div className="kb-list-desc">{h.snippet}</div> : null}
                  </button>
                ))}
          </div>
          <div className="kb-detail-pane">
            {pageDetail ? (
              <div className="kb-editor" data-testid="confluence-page">
                <div className="kb-editor-head">
                  <h3>{pageDetail.title}</h3>
                  {pageDetail.sourceUrl ? <a href={pageDetail.sourceUrl} target="_blank" rel="noreferrer" className="btn btn-ghost small">↗ source</a> : null}
                </div>
                <pre className="tool-card-pre">{pageDetail.content}</pre>
              </div>
            ) : <div className="dash-empty">click a hit to load the page</div>}
          </div>
        </div>
      ) : null}
    </div>
  )
}
