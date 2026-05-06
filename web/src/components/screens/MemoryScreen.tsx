import { useEffect, useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { listMemory, getMemory, writeMemory } from '../../lib/api'

export function MemoryScreen(): JSX.Element {
  const list = useApi('memory.list', listMemory)
  const [selected, setSelected] = useState<string | null>(null)
  const [creatingName, setCreatingName] = useState<string | null>(null)
  const entries = list.data?.entries ?? []

  return (
    <div className="kb-screen" data-testid="memory">
      <div className="kb-header">
        <h2>Memory</h2>
        <div className="kb-meta">{entries.length} files · operator notepad — markdown at <code>{'<kbRoot>/memory/<name>.md'}</code></div>
        <button className="btn btn-primary" onClick={() => setCreatingName('')} data-testid="memory-new">+ new entry</button>
      </div>
      <div className="kb-2col">
        <div className="kb-list" data-testid="memory-list">
          {entries.length === 0 ? <div className="dash-empty">no memory entries yet</div> : (
            entries.map((m) => (
              <button key={m.name}
                className={`kb-list-row ${selected === m.name ? 'active' : ''}`}
                onClick={() => setSelected(m.name)}
                data-testid={`memory-list-${m.name}`}>
                <div className="kb-list-name">{m.name}</div>
                <div className="kb-list-desc">{m.size} bytes · {new Date(m.mtime).toLocaleString()}</div>
              </button>
            ))
          )}
        </div>
        <div className="kb-detail-pane">
          {creatingName !== null
            ? <MemoryEditor key="new" name={creatingName} isNew onClose={() => setCreatingName(null)}
                onSaved={(n) => { list.reload(); setCreatingName(null); setSelected(n) }} />
            : selected
              ? <MemoryEditor key={selected} name={selected} onClose={() => setSelected(null)} onSaved={() => list.reload()} />
              : <div className="dash-empty">Select a memory entry to view + edit.</div>}
        </div>
      </div>
    </div>
  )
}

function MemoryEditor({ name: initialName, isNew, onClose, onSaved }: { name: string; isNew?: boolean; onClose: () => void; onSaved: (name: string) => void }): JSX.Element {
  const [name, setName] = useState(initialName)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(isNew ?? false)

  useEffect(() => {
    if (isNew) { setLoaded(true); return }
    let cancelled = false
    getMemory(initialName).then((d) => { if (!cancelled) { setBody(d.body); setLoaded(true) } }).catch((e) => setError((e as Error).message))
    return () => { cancelled = true }
  }, [initialName, isNew])

  const save = async () => {
    setBusy(true); setError(null)
    try {
      await writeMemory(name, body)
      onSaved(name)
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  if (!loaded) return <div className="dash-empty">loading…</div>

  return (
    <div className="kb-editor" data-testid={`memory-editor-${name || 'new'}`}>
      <div className="kb-editor-head">
        {isNew
          ? <input className="input" placeholder="memory-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="memory-editor-name"/>
          : <h3 data-testid="memory-editor-name">{name}</h3>}
        <button className="btn btn-ghost" onClick={onClose}>×</button>
      </div>
      <textarea className="kb-editor-body" value={body} onChange={(e) => setBody(e.target.value)} rows={20} data-testid="memory-editor-body"/>
      {error ? <div className="chat-msg-error">{error}</div> : null}
      <div className="kb-editor-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy || !name} data-testid="memory-editor-save">{busy ? 'saving…' : 'save'}</button>
      </div>
    </div>
  )
}
