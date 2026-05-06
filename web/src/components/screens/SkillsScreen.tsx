import { useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { getKbGraph, createSkill, updateSkill, getKbSkill, type SkillNode, type KbDetail } from '../../lib/api'
import { useEffect } from 'react'

export function SkillsScreen(): JSX.Element {
  const list = useApi('skills.list', getKbGraph)
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const skills: SkillNode[] = (list.data?.nodes ?? []).filter((n) => n.source === 'skill')

  return (
    <div className="kb-screen" data-testid="skills">
      <div className="kb-header">
        <h2>Skills</h2>
        <div className="kb-meta">{skills.length} on disk · <code>{'<kbRoot>/skills/<name>/SKILL.md'}</code></div>
        <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="skills-new">+ new skill</button>
      </div>
      <div className="kb-2col">
        <div className="kb-list" data-testid="skills-list">
          {skills.length === 0 ? <div className="dash-empty">no skills yet</div> : (
            skills.map((s) => (
              <button
                key={s.name}
                className={`kb-list-row ${selected === s.name ? 'active' : ''}`}
                onClick={() => setSelected(s.name)}
                data-testid={`skill-list-${s.name}`}
              >
                <div className="kb-list-name">{s.name}</div>
                {s.description ? <div className="kb-list-desc">{s.description}</div> : null}
              </button>
            ))
          )}
        </div>
        <div className="kb-detail-pane">
          {selected ? (
            <SkillEditor name={selected} onClose={() => setSelected(null)} onSaved={() => list.reload()} />
          ) : (
            <div className="dash-empty">Select a skill on the left to view + edit.</div>
          )}
        </div>
      </div>
      {creating ? (
        <SkillCreateModal onClose={() => setCreating(false)} onCreated={(n) => { list.reload(); setCreating(false); setSelected(n) }} />
      ) : null}
    </div>
  )
}

function SkillEditor({ name, onClose, onSaved }: { name: string; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [body, setBody] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    getKbSkill(name).then((d: KbDetail) => {
      if (cancelled) return
      setBody(d.body); setDescription(typeof d.frontmatter.description === 'string' ? d.frontmatter.description : ''); setLoaded(true)
    }).catch((e: Error) => setError(e.message))
    return () => { cancelled = true }
  }, [name])

  const save = async () => {
    setBusy(true); setError(null)
    try {
      await updateSkill(name, { content: body, frontmatter: { name, description } })
      onSaved()
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <div className="kb-editor" data-testid={`skill-editor-${name}`}>
      <div className="kb-editor-head">
        <h3 data-testid="skill-editor-name">{name}</h3>
        <button className="btn btn-ghost" onClick={onClose}>×</button>
      </div>
      {!loaded ? <div className="dash-empty">loading…</div> : (
        <>
          <label className="kk-label-tiny">DESCRIPTION</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="skill-editor-description"/>
          <label className="kk-label-tiny">BODY</label>
          <textarea className="kb-editor-body" value={body} onChange={(e) => setBody(e.target.value)} rows={18} data-testid="skill-editor-body"/>
          {error ? <div className="chat-msg-error">{error}</div> : null}
          <div className="kb-editor-actions">
            <button className="btn btn-primary" onClick={save} disabled={busy} data-testid="skill-editor-save">{busy ? 'saving…' : 'save'}</button>
          </div>
        </>
      )}
    </div>
  )
}

function SkillCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }): JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await createSkill({ name, content: body, frontmatter: { description } })
      onCreated(name)
    } catch (err) { setError((err as Error).message); setBusy(false) }
  }

  return (
    <div className="kb-modal-shade" onClick={onClose}>
      <form className="kb-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} data-testid="skill-create-modal">
        <h3>New Skill</h3>
        <label className="kk-label-tiny">NAME</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="lowercase-kebab-name" autoFocus data-testid="skill-create-name"/>
        <label className="kk-label-tiny">DESCRIPTION</label>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="skill-create-description"/>
        <label className="kk-label-tiny">BODY (markdown)</label>
        <textarea className="kb-editor-body" value={body} onChange={(e) => setBody(e.target.value)} rows={10} data-testid="skill-create-body"/>
        {error ? <div className="chat-msg-error">{error}</div> : null}
        <div className="kb-editor-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name} data-testid="skill-create-submit">{busy ? 'creating…' : 'create'}</button>
        </div>
      </form>
    </div>
  )
}
