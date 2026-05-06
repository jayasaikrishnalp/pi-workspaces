import { useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { listWorkflows, createWorkflow, type WorkflowSummary, type WorkflowStep } from '../../lib/api'

export function WorkflowsScreen(): JSX.Element {
  const list = useApi('workflows.list', listWorkflows)
  const [creating, setCreating] = useState(false)
  const workflows = list.data?.workflows ?? []

  return (
    <div className="kb-screen" data-testid="workflows">
      <div className="kb-header">
        <h2>Workflows</h2>
        <div className="kb-meta">{workflows.length} on disk · ordered runbooks · steps reference skills or other workflows</div>
        <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="workflows-new">+ new workflow</button>
      </div>
      <div className="kb-list" data-testid="workflows-list" style={{ maxHeight: 'none' }}>
        {workflows.length === 0 ? <div className="dash-empty">no workflows yet — POST /api/workflows or click "+ new workflow"</div>
          : workflows.map((w: WorkflowSummary) => (
              <div key={w.name} className="kb-list-row" data-testid={`workflow-row-${w.name}`}>
                <div className="kb-list-name">{w.name}</div>
                {w.description ? <div className="kb-list-desc">{w.description}</div> : null}
                <div className="kb-list-desc" style={{ fontFamily: 'var(--font-mono)' }}>
                  {w.steps.length} step{w.steps.length === 1 ? '' : 's'}: {w.steps.map((s) => `${s.kind}:${s.ref}`).join(' → ')}
                </div>
              </div>
            ))}
      </div>
      {creating ? <WorkflowCreateModal onClose={() => setCreating(false)} onCreated={() => { list.reload(); setCreating(false) }} /> : null}
    </div>
  )
}

function WorkflowCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [stepsText, setStepsText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null)
    try {
      const steps: WorkflowStep[] = stepsText.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const m = /^(skill|workflow):(.+)$/.exec(line)
        if (!m) throw new Error(`bad step "${line}" — must be "skill:<name>" or "workflow:<name>"`)
        return { kind: m[1] as 'skill' | 'workflow', ref: m[2]! }
      })
      if (steps.length === 0) throw new Error('at least one step is required')
      await createWorkflow({ name, description: description || undefined, steps })
      onCreated()
    } catch (err) { setError((err as Error).message); setBusy(false) }
  }

  return (
    <div className="kb-modal-shade" onClick={onClose}>
      <form className="kb-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} data-testid="workflow-create-modal">
        <h3>New Workflow</h3>
        <label className="kk-label-tiny">NAME</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="lowercase-kebab-name" autoFocus data-testid="workflow-create-name"/>
        <label className="kk-label-tiny">DESCRIPTION</label>
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="workflow-create-description"/>
        <label className="kk-label-tiny">STEPS — one per line, format <code>skill:&lt;name&gt;</code> or <code>workflow:&lt;name&gt;</code></label>
        <textarea className="kb-editor-body" rows={8} value={stepsText} onChange={(e) => setStepsText(e.target.value)}
                  placeholder={'skill:check-server-health\nskill:reboot-server'} data-testid="workflow-create-steps"/>
        {error ? <div className="chat-msg-error">{error}</div> : null}
        <div className="kb-editor-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name} data-testid="workflow-create-submit">{busy ? 'creating…' : 'create'}</button>
        </div>
      </form>
    </div>
  )
}
