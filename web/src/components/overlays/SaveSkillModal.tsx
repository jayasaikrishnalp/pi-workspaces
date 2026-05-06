import { useState } from 'react'
import { createSkill } from '../../lib/api'

interface Props {
  open: boolean
  onClose: () => void
  onSaved: (name: string) => void
  initialBody?: string
}

export function SaveSkillModal({ open, onClose, onSaved, initialBody }: Props): JSX.Element | null {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState(initialBody ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name) return
    setBusy(true); setError(null)
    try {
      await createSkill({ name, content: body, frontmatter: { description } })
      onSaved(name)
    } catch (err) { setError((err as Error).message); setBusy(false) }
  }

  return (
    <div className="kb-modal-shade" onClick={onClose}>
      <form className="kb-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} data-testid="save-skill-modal">
        <h3>Save as skill</h3>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>
          Distill the current message into a permanent runbook. The next on-call gets it for free.
        </p>
        <label className="kk-label-tiny">NAME</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="lowercase-kebab-name" autoFocus data-testid="save-skill-name"/>
        <label className="kk-label-tiny">DESCRIPTION</label>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="save-skill-description"/>
        <label className="kk-label-tiny">BODY</label>
        <textarea className="kb-editor-body" rows={12} value={body} onChange={(e) => setBody(e.target.value)} data-testid="save-skill-body"/>
        {error ? <div className="chat-msg-error">{error}</div> : null}
        <div className="kb-editor-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name} data-testid="save-skill-submit">{busy ? 'saving…' : 'save skill'}</button>
        </div>
      </form>
    </div>
  )
}
