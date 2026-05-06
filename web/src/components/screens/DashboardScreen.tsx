import { useApi } from '../../hooks/useApi'
import { listJobs, listTasks, probe, type Job, type Task } from '../../lib/api'
import type { ScreenId } from '../Sidebar'

interface Props { onPick?: (id: ScreenId) => void }

interface StatCardProps {
  label: string
  value: number | string
  hint?: string
  testId?: string
}

function StatCard({ label, value, hint, testId }: StatCardProps): JSX.Element {
  return (
    <div className="dash-card" data-testid={testId}>
      <div className="dash-card-label">{label}</div>
      <div className="dash-card-value" data-testid={testId ? `${testId}-value` : undefined}>{value}</div>
      {hint ? <div className="dash-card-hint">{hint}</div> : null}
    </div>
  )
}

function JobRow({ job }: { job: Job }): JSX.Element {
  return (
    <div className="dash-row" data-testid={`job-row-${job.id}`}>
      <span className={`dash-row-status status-${job.status}`}>{job.status}</span>
      <span className="dash-row-title">{job.title ?? job.run_id ?? job.id.slice(0, 8)}</span>
      <span className="dash-row-meta">{new Date(job.created_at).toLocaleTimeString()}</span>
    </div>
  )
}

function TaskRow({ task }: { task: Task }): JSX.Element {
  return (
    <div className="dash-row" data-testid={`task-row-${task.id}`}>
      <span className={`dash-row-status status-${task.status}`}>{task.status}</span>
      <span className="dash-row-title">{task.title}</span>
      <span className="dash-row-meta">{task.source}</span>
    </div>
  )
}

export function DashboardScreen({ onPick }: Props = {}): JSX.Element {
  const probeState = useApi('dashboard.probe', probe)
  const jobsState = useApi('dashboard.jobs', () => listJobs({ limit: 5 }))
  const tasksState = useApi('dashboard.tasks', () => listTasks({ limit: 5 }))

  const p = probeState.data
  const counts = {
    skills: p?.skills.count ?? 0,
    agents: p?.agents.count ?? 0,
    workflows: p?.workflows.count ?? 0,
    memory: p?.memory.count ?? 0,
    souls: p?.souls?.count ?? 0,
    jobs: p?.jobs?.count ?? 0,
    tasks: p?.tasks?.count ?? 0,
    terminal: p?.terminal?.count ?? 0,
  }

  return (
    <div className="dashboard" data-testid="dashboard">
      <div className="dash-header">
        <div>
          <h2>Dashboard</h2>
          <div className="dash-sub">
            {p ? (p.pi.ok ? `pi ${p.pi.version ?? ''}` : 'pi offline') : 'probing…'}
            {p?.pi.activeModel ? ` · ${p.pi.activeModel}` : ''}
          </div>
          <div className="dash-quick-actions" data-testid="dash-quick-actions">
            <button className="btn btn-primary" onClick={() => onPick?.('chat')} data-testid="dash-action-chat">NEW CHAT →</button>
            <button className="btn btn-secondary" onClick={() => onPick?.('terminal')} data-testid="dash-action-terminal">TERMINAL →</button>
            <button className="btn btn-secondary" onClick={() => onPick?.('skills')} data-testid="dash-action-skills">SKILLS →</button>
            <button className="btn btn-ghost" onClick={() => onPick?.('graph')} data-testid="dash-action-graph">GRAPH →</button>
          </div>
        </div>
        {p?.mcp ? (
          <div className="dash-mcp" data-testid="dash-mcp">
            {p.mcp.servers.map((s) => (
              <span key={s.id} className={`mcp-pill mcp-${s.status}`} data-testid={`mcp-pill-${s.id}`}>
                {s.id} · {s.status} {s.toolCount > 0 ? `· ${s.toolCount} tools` : ''}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="dash-grid" data-testid="dash-grid">
        <StatCard testId="stat-skills"    label="SKILLS"    value={counts.skills} />
        <StatCard testId="stat-agents"    label="AGENTS"    value={counts.agents} />
        <StatCard testId="stat-souls"     label="SOULS"     value={counts.souls}    hint="character/identity" />
        <StatCard testId="stat-workflows" label="WORKFLOWS" value={counts.workflows} />
        <StatCard testId="stat-memory"    label="MEMORY"    value={counts.memory} />
        <StatCard testId="stat-jobs"      label="JOBS"      value={counts.jobs} />
        <StatCard testId="stat-tasks"     label="TASKS"     value={counts.tasks} />
        <StatCard testId="stat-terminal"  label="TERMINAL"  value={counts.terminal} hint="commands run" />
      </div>

      <div className="dash-2col">
        <div className="dash-panel" data-testid="dash-recent-jobs">
          <div className="dash-panel-head">
            <span className="kk-label-tiny">RECENT JOBS</span>
            <span className="dash-panel-meta">{jobsState.data?.jobs?.length ?? 0}</span>
          </div>
          {jobsState.loading && !jobsState.data ? (
            <div className="dash-empty">loading…</div>
          ) : jobsState.data?.jobs?.length === 0 ? (
            <div className="dash-empty" data-testid="dash-jobs-empty">no jobs yet — start a chat session to create one</div>
          ) : (
            <div className="dash-rows">
              {jobsState.data?.jobs?.map((j) => <JobRow key={j.id} job={j} />)}
            </div>
          )}
        </div>

        <div className="dash-panel" data-testid="dash-recent-tasks">
          <div className="dash-panel-head">
            <span className="kk-label-tiny">RECENT TASKS</span>
            <span className="dash-panel-meta">{tasksState.data?.tasks?.length ?? 0}</span>
          </div>
          {tasksState.loading && !tasksState.data ? (
            <div className="dash-empty">loading…</div>
          ) : tasksState.data?.tasks?.length === 0 ? (
            <div className="dash-empty" data-testid="dash-tasks-empty">no tasks yet</div>
          ) : (
            <div className="dash-rows">
              {tasksState.data?.tasks?.map((t) => <TaskRow key={t.id} task={t} />)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
