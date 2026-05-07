import { useState } from 'react'

import { Icons } from '../icons/Icons'
import {
  AGENT_KIND_META,
  type Agent,
  type AgentKind,
} from '../../lib/agents-store'

type Editing = null | 'new' | string
interface Draft extends Omit<Agent, 'skills'> { skillsText: string }

interface Props {
  roster: Agent[]
  setRoster: (next: Agent[] | ((prev: Agent[]) => Agent[])) => void
}

const KINDS: AgentKind[] = ['router', 'specialist', 'reviewer', 'operator', 'writer']

function blankDraft(): Draft {
  return {
    id: 'agent-' + Math.random().toString(36).slice(2, 7),
    name: 'New Agent',
    kind: 'specialist',
    role: 'What does this agent do?',
    model: 'claude-sonnet-4-5',
    skillsText: '',
    prompt: 'You are the …',
  }
}

function iconFor(name: string) {
  // Icons keyed by string at runtime — fall back to swarm.
  const all = Icons as unknown as Record<string, (p: { size?: number }) => JSX.Element>
  return all[name] ?? all.swarm
}

export function AgentsScreen({ roster, setRoster }: Props): JSX.Element {
  const [editing, setEditing] = useState<Editing>(null)
  const [draft, setDraft] = useState<Draft | null>(null)

  const startEdit = (a: Agent) => {
    setEditing(a.id)
    setDraft({ ...a, skillsText: (a.skills || []).join('\n') })
  }
  const startNew = () => { setEditing('new'); setDraft(blankDraft()) }
  const cancel = () => { setEditing(null); setDraft(null) }
  const save = () => {
    if (!draft) return
    const skills = draft.skillsText.split(/\n+/).map((s) => s.trim()).filter(Boolean)
    const { skillsText: _drop, ...rest } = draft
    void _drop
    const next: Agent = { ...rest, skills }
    setRoster((prev) => {
      const exists = prev.find((a) => a.id === next.id)
      return exists ? prev.map((a) => (a.id === next.id ? next : a)) : [...prev, next]
    })
    cancel()
  }
  const remove = (id: string) => {
    if (!window.confirm('Delete this agent? Workflows that reference it will keep the snapshot.')) return
    setRoster((prev) => prev.filter((a) => a.id !== id))
  }
  const duplicate = (a: Agent) => {
    const copy: Agent = { ...a, id: a.id + '-copy', name: a.name + ' (copy)' }
    setRoster((prev) => [...prev, copy])
  }

  return (
    <div className="page-root agents-screen" data-testid="agents-screen">
      <div className="page-header">
        <div className="ph-icon"><Icons.profiles size={18} /></div>
        <div className="ph-text">
          <div className="ph-title">Agents</div>
          <div className="ph-sub">
            Reusable agent definitions. Compose them into a Workflow to run as a pipeline.
          </div>
        </div>
        <div className="ph-actions">
          <button className="btn btn-accent" onClick={startNew} data-testid="agents-new">
            + New agent
          </button>
        </div>
      </div>

      <div className="agents-grid">
        {roster.map((a) => {
          const meta = AGENT_KIND_META[a.kind]
          const Icon = iconFor(meta.icon)
          return (
            <div
              key={a.id}
              className="agent-card kk-card"
              style={{ ['--k' as never]: meta.color, ['--kbg' as never]: meta.bg } as React.CSSProperties}
              data-testid={`agent-card-${a.id}`}
            >
              <div className="agent-card-head">
                <div className="agent-card-avatar"><Icon size={16} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="agent-card-name mono">{a.name}</div>
                  <div className="agent-card-id mono tiny mute">{a.id}</div>
                </div>
                <span className="agent-card-kind mono tiny">{a.kind}</span>
              </div>
              <div className="agent-card-role">{a.role}</div>
              <div className="agent-card-meta">
                <span className="mono tiny mute">{a.model}</span>
                <span className="mono tiny mute">·</span>
                <span className="mono tiny mute">{a.skills.length} skills</span>
              </div>
              <div className="agent-card-skills">
                {a.skills.slice(0, 4).map((s) => (
                  <span key={s} className="cd-skill-pill">{s}</span>
                ))}
                {a.skills.length > 4 ? <span className="cd-skill-pill">+{a.skills.length - 4}</span> : null}
              </div>
              <div className="agent-card-actions">
                <button className="btn btn-ghost small" onClick={() => startEdit(a)} data-testid={`agent-edit-${a.id}`}>Edit</button>
                <button className="btn btn-ghost small" onClick={() => duplicate(a)}>Duplicate</button>
                <button className="btn btn-ghost small agent-delete" onClick={() => remove(a.id)} data-testid={`agent-delete-${a.id}`}>Delete</button>
              </div>
            </div>
          )
        })}
        {roster.length === 0 ? (
          <div className="agents-empty dash-empty">No agents yet. Create one to get started.</div>
        ) : null}
      </div>

      {editing && draft ? (
        <div className="agent-modal-backdrop" onClick={cancel}>
          <div className="agent-modal" onClick={(e) => e.stopPropagation()} data-testid="agent-modal">
            <div className="agent-modal-head">
              <Icons.profiles size={16} />
              <span className="mono">{editing === 'new' ? 'Create agent' : 'Edit agent'}</span>
              <button className="btn btn-ghost small" style={{ marginLeft: 'auto' }} onClick={cancel}>×</button>
            </div>
            <div className="agent-modal-body">
              <div className="agent-form-row">
                <label className="kk-label-tiny">Name</label>
                <input className="agent-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="agent-form-row two">
                <div>
                  <label className="kk-label-tiny">ID</label>
                  <input className="agent-input mono" value={draft.id} onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
                </div>
                <div>
                  <label className="kk-label-tiny">Kind</label>
                  <select className="agent-input mono" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as AgentKind })}>
                    {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
              </div>
              <div className="agent-form-row">
                <label className="kk-label-tiny">Role</label>
                <input className="agent-input" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
              </div>
              <div className="agent-form-row">
                <label className="kk-label-tiny">Model</label>
                <input className="agent-input mono" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
              </div>
              <div className="agent-form-row">
                <label className="kk-label-tiny">Skills (one per line)</label>
                <textarea className="agent-input mono" rows={5} value={draft.skillsText} onChange={(e) => setDraft({ ...draft, skillsText: e.target.value })} />
              </div>
              <div className="agent-form-row">
                <label className="kk-label-tiny">System prompt</label>
                <textarea className="agent-input mono" rows={6} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
              </div>
            </div>
            <div className="agent-modal-foot">
              <button className="btn btn-ghost" onClick={cancel}>Cancel</button>
              <button className="btn btn-accent" onClick={save} data-testid="agent-save">
                {editing === 'new' ? 'Create' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
