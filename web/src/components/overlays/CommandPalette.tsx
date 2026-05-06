import { useEffect, useState, useMemo } from 'react'

import { search, type SearchResult } from '../../lib/api'
import type { ScreenId } from '../Sidebar'

interface Item { id: string; label: string; section: string; onPick: () => void; hint?: string }

interface Props {
  open: boolean
  onClose: () => void
  onPick: (id: ScreenId) => void
}

const SCREEN_ITEMS: Array<{ id: ScreenId; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'chat',      label: 'Chat' },
  { id: 'graph',     label: 'Knowledge Graph' },
  { id: 'skills',    label: 'Skills' },
  { id: 'souls',     label: 'Souls' },
  { id: 'memory',    label: 'Memory' },
  { id: 'jobs',      label: 'Jobs' },
  { id: 'tasks',     label: 'Tasks' },
  { id: 'terminal',  label: 'Terminal' },
  { id: 'mcp',       label: 'MCP' },
  { id: 'confluence',label: 'Confluence' },
]

export function CommandPalette({ open, onClose, onPick }: Props): JSX.Element | null {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [active, setActive] = useState(0)

  // FTS5 search debounced.
  useEffect(() => {
    if (!open || !q.trim() || q.length < 2) { setResults([]); return }
    const handle = setTimeout(() => {
      search(q, { limit: 8 }).then((r) => setResults(r.results)).catch(() => setResults([]))
    }, 200)
    return () => clearTimeout(handle)
  }, [q, open])

  useEffect(() => { if (open) { setQ(''); setActive(0) } }, [open])

  const items: Item[] = useMemo(() => {
    const filtered = SCREEN_ITEMS.filter((s) => !q || s.label.toLowerCase().includes(q.toLowerCase()))
      .map<Item>((s) => ({ id: `go-${s.id}`, section: 'GO', label: s.label, onPick: () => { onPick(s.id); onClose() } }))
    const fts = results.map<Item>((r) => ({
      id: `fts-${r.kind}-${r.name ?? r.messageId ?? Math.random()}`,
      section: r.kind.toUpperCase(),
      label: r.name ?? r.snippet.replace(/<<|>>/g, '').slice(0, 64),
      hint: r.snippet.replace(/<<|>>/g, ''),
      onPick: () => {
        if (r.name && (r.kind === 'skill' || r.kind === 'soul' || r.kind === 'memory' || r.kind === 'agent' || r.kind === 'workflow')) {
          // navigate to the kind's screen
          const target: Record<string, ScreenId> = { skill: 'skills', soul: 'souls', memory: 'memory', agent: 'graph', workflow: 'graph' }
          onPick(target[r.kind] ?? 'graph')
        }
        onClose()
      },
    }))
    return [...filtered, ...fts]
  }, [q, results, onPick, onClose])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)) }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
      else if (e.key === 'Enter')     { e.preventDefault(); items[active]?.onPick() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, items, active, onClose])

  if (!open) return null

  let prevSection: string | null = null
  return (
    <div className="kb-modal-shade" onClick={onClose}>
      <div className="cmdk-modal" onClick={(e) => e.stopPropagation()} data-testid="cmdk-overlay">
        <input
          className="cmdk-input"
          autoFocus
          value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0) }}
          placeholder="search screens or KB content…"
          data-testid="cmdk-input"
        />
        <div className="cmdk-list" data-testid="cmdk-list">
          {items.length === 0 ? <div className="dash-empty">no matches</div>
            : items.map((it, i) => {
                const sectionHeader = it.section !== prevSection ? <div key={`h-${it.section}`} className="cmdk-section">{it.section}</div> : null
                prevSection = it.section
                return (
                  <div key={it.id}>
                    {sectionHeader}
                    <button className={`cmdk-item ${active === i ? 'active' : ''}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => it.onPick()}
                      data-testid={`cmdk-item-${it.id}`}>
                      <span>{it.label}</span>
                      {it.hint ? <span className="cmdk-hint">{it.hint}</span> : null}
                    </button>
                  </div>
                )
              })}
        </div>
      </div>
    </div>
  )
}
