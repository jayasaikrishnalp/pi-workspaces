import { useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { listTasks, createTask, updateTask, type Task } from '../../lib/api'

const COLUMNS: Array<{ status: Task['status']; label: string }> = [
  { status: 'triage',  label: 'TRIAGE' },
  { status: 'todo',    label: 'TODO' },
  { status: 'ready',   label: 'READY' },
  { status: 'running', label: 'RUNNING' },
  { status: 'blocked', label: 'BLOCKED' },
  { status: 'done',    label: 'DONE' },
]

const NEXT_STATUS: Record<Task['status'], Task['status'] | null> = {
  triage:  'todo',
  todo:    'ready',
  ready:   'running',
  running: 'done',
  blocked: 'todo',
  done:    'archived',
  archived: null,
}

export function TasksScreen(): JSX.Element {
  const { data, reload } = useApi('tasks.list', () => listTasks({ limit: 200 }))
  const [creating, setCreating] = useState(false)
  const tasks = (data?.tasks ?? []).filter((t) => t.status !== 'archived')

  const advance = async (t: Task) => {
    const next = NEXT_STATUS[t.status]; if (!next) return
    try { await updateTask(t.id, { status: next }); reload() } catch (e) { alert((e as Error).message) }
  }

  return (
    <div className="kb-screen tasks-screen" data-testid="tasks">
      <div className="kb-header">
        <h2>Tasks</h2>
        <div className="kb-meta">{tasks.length} active · operator + agent todos · drag through the kanban states</div>
        <button className="btn btn-primary" onClick={() => setCreating(true)} data-testid="tasks-new">+ new task</button>
      </div>
      <div className="kanban" data-testid="kanban">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.status).sort((a, b) => a.priority - b.priority)
          return (
            <div key={col.status} className="kanban-col" data-testid={`kanban-col-${col.status}`}>
              <div className="kanban-col-head">
                <span className={`dash-row-status status-${col.status}`}>{col.label}</span>
                <span className="kanban-count">{colTasks.length}</span>
              </div>
              <div className="kanban-col-body">
                {colTasks.map((t) => (
                  <div key={t.id} className="kanban-card" data-testid={`task-card-${t.id}`}>
                    <div className="kanban-card-title">{t.title}</div>
                    <div className="kanban-card-meta">
                      <span className="kanban-card-source">{t.source}</span>
                      {t.priority !== 0 ? <span className="kanban-card-priority">P{t.priority}</span> : null}
                    </div>
                    {NEXT_STATUS[t.status] ? (
                      <button className="btn btn-accent small" onClick={() => advance(t)} data-testid={`task-advance-${t.id}`}>
                        → {NEXT_STATUS[t.status]}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {creating ? <TaskCreateModal onClose={() => setCreating(false)} onCreated={() => { reload(); setCreating(false) }} /> : null}
    </div>
  )
}

function TaskCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }): JSX.Element {
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null)
    try { await createTask({ title, priority }); onCreated() }
    catch (err) { setError((err as Error).message); setBusy(false) }
  }
  return (
    <div className="kb-modal-shade" onClick={onClose}>
      <form className="kb-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} data-testid="task-create-modal">
        <h3>New Task</h3>
        <label className="kk-label-tiny">TITLE</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus data-testid="task-create-title"/>
        <label className="kk-label-tiny">PRIORITY (0 = highest)</label>
        <input className="input" type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value) || 0)}/>
        {error ? <div className="chat-msg-error">{error}</div> : null}
        <div className="kb-editor-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !title} data-testid="task-create-submit">{busy ? 'creating…' : 'create'}</button>
        </div>
      </form>
    </div>
  )
}
