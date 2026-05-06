import { useEffect, useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { listSouls, createSoul, getSoul, updateSoul, type SoulInput } from '../../lib/api'

export function SoulsScreen(): JSX.Element {
  const list = useApi('souls.list', listSouls)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const souls = list.data?.souls ?? []

  return (
    <div className="kb-screen" data-testid="souls">
      <div className="kb-header">
        <h2>Souls</h2>
        <div className="kb-meta">{souls.length} on disk · the character/identity layer attached to agents</div>
        <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="souls-new">+ new soul</button>
      </div>
      <div className="kb-2col">
        <div className="kb-list" data-testid="souls-list">
          {souls.length === 0 ? <div className="dash-empty">no souls yet</div> : (
            souls.map((s) => (
              <button key={s.name}
                className={`kb-list-row ${selected === s.name ? 'active' : ''}`}
                onClick={() => setSelected(s.name)}
                data-testid={`soul-list-${s.name}`}>
                <div className="kb-list-name">{s.name}</div>
                {s.description ? <div className="kb-list-desc">{s.description}</div> : null}
              </button>
            ))
          )}
        </div>
        <div className="kb-detail-pane">
          {selected
            ? <SoulEditor key={selected} name={selected} onClose={() => setSelected(null)} onSaved={() => list.reload()} />
            : <div className="dash-empty">Select a soul to view + edit.</div>}
        </div>
      </div>
      {creating ? <SoulCreateModal onClose={() => setCreating(false)} onCreated={(n) => { list.reload(); setCreating(false); setSelected(n) }} /> : null}
    </div>
  )
}

function SoulEditor({ name, onClose, onSaved }: { name: string; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [fm, setFm] = useState<Record<string, unknown> | null>(null)
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    getSoul(name).then((d) => { if (!cancelled) { setFm(d.frontmatter); setBody(d.body) } }).catch((e) => setError((e as Error).message))
    return () => { cancelled = true }
  }, [name])

  const f = fm ?? {}
  const arrField = (key: string): string =>
    Array.isArray(f[key]) ? (f[key] as unknown[]).filter((x) => typeof x === 'string').join(', ') : ''
  const setStr = (key: string, v: string) => setFm({ ...(fm ?? {}), [key]: v })
  const setArr = (key: string, v: string) => setFm({ ...(fm ?? {}), [key]: v.split(',').map((s) => s.trim()).filter(Boolean) })

  const save = async () => {
    if (!fm) return
    setBusy(true); setError(null)
    try {
      const patch: Partial<SoulInput> = {
        description: typeof f.description === 'string' ? f.description : undefined,
        values: Array.isArray(f.values) ? (f.values as string[]) : undefined,
        priorities: Array.isArray(f.priorities) ? (f.priorities as string[]) : undefined,
        decision_principles: Array.isArray(f.decision_principles) ? (f.decision_principles as string[]) : undefined,
        tone: typeof f.tone === 'string' ? f.tone : undefined,
        body,
      }
      await updateSoul(name, patch)
      onSaved()
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  if (!fm) return <div className="dash-empty">loading…</div>

  return (
    <div className="kb-editor" data-testid={`soul-editor-${name}`}>
      <div className="kb-editor-head">
        <h3 data-testid="soul-editor-name">{name}</h3>
        <button className="btn btn-ghost" onClick={onClose}>×</button>
      </div>
      <label className="kk-label-tiny">DESCRIPTION</label>
      <input className="input" value={typeof f.description === 'string' ? f.description : ''} onChange={(e) => setStr('description', e.target.value)} data-testid="soul-editor-description"/>
      <label className="kk-label-tiny">VALUES (comma-separated)</label>
      <input className="input" value={arrField('values')} onChange={(e) => setArr('values', e.target.value)} data-testid="soul-editor-values"/>
      <label className="kk-label-tiny">PRIORITIES</label>
      <input className="input" value={arrField('priorities')} onChange={(e) => setArr('priorities', e.target.value)}/>
      <label className="kk-label-tiny">DECISION PRINCIPLES</label>
      <input className="input" value={arrField('decision_principles')} onChange={(e) => setArr('decision_principles', e.target.value)}/>
      <label className="kk-label-tiny">TONE</label>
      <input className="input" value={typeof f.tone === 'string' ? f.tone : ''} onChange={(e) => setStr('tone', e.target.value)}/>
      <label className="kk-label-tiny">NARRATIVE</label>
      <textarea className="kb-editor-body" value={body} onChange={(e) => setBody(e.target.value)} rows={8}/>
      {error ? <div className="chat-msg-error">{error}</div> : null}
      <div className="kb-editor-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy} data-testid="soul-editor-save">{busy ? 'saving…' : 'save'}</button>
      </div>
    </div>
  )
}

function SoulCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }): JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [values, setValues] = useState('')
  const [tone, setTone] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null)
    try {
      await createSoul({
        name, description,
        values: values ? values.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        tone: tone || undefined,
      })
      onCreated(name)
    } catch (err) { setError((err as Error).message); setBusy(false) }
  }
  return (
    <div className="kb-modal-shade" onClick={onClose}>
      <form className="kb-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} data-testid="soul-create-modal">
        <h3>New Soul</h3>
        <label className="kk-label-tiny">NAME</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus data-testid="soul-create-name"/>
        <label className="kk-label-tiny">DESCRIPTION</label>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="soul-create-description"/>
        <label className="kk-label-tiny">VALUES (comma-separated)</label>
        <input className="input" value={values} onChange={(e) => setValues(e.target.value)} data-testid="soul-create-values"/>
        <label className="kk-label-tiny">TONE</label>
        <input className="input" value={tone} onChange={(e) => setTone(e.target.value)}/>
        {error ? <div className="chat-msg-error">{error}</div> : null}
        <div className="kb-editor-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name} data-testid="soul-create-submit">{busy ? 'creating…' : 'create'}</button>
        </div>
      </form>
    </div>
  )
}
