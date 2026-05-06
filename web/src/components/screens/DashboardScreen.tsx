import { useApi } from '../../hooks/useApi'
import {
  listJobs, listTasks, probe, listProviders, getActiveProvider, setActiveProvider,
  type Job, type Task, type Provider,
} from '../../lib/api'
import { useState, useEffect } from 'react'
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

/**
 * Provider + model matrix wired to /api/providers + /api/providers/active.
 * Lets the operator see which providers are configured, how many models each
 * exposes, and pick the active one inline (no need to dive into Settings).
 */
function ProvidersPanel({ testId }: { testId?: string }): JSX.Element {
  const list = useApi('dash.providers', listProviders)
  const active = useApi('dash.active-provider', getActiveProvider)
  const [pendingProvider, setPendingProvider] = useState<string | null>(null)
  const [pendingModel, setPendingModel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (active.data) {
      setPendingProvider(active.data.providerId)
      setPendingModel(active.data.modelId)
    }
  }, [active.data])

  const provs: Provider[] = list.data?.providers ?? []
  const selected = provs.find((p) => p.id === pendingProvider)
  const isActive = (p: Provider) => active.data?.providerId === p.id

  const apply = async () => {
    if (!pendingProvider || !pendingModel) return
    setBusy(true); setError(null)
    try {
      await setActiveProvider(pendingProvider, pendingModel)
      active.reload()
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <div className="dash-panel" data-testid={testId}>
      <div className="dash-panel-head">
        <span className="kk-label-tiny">MODELS &amp; PROVIDERS</span>
        <span className="dash-panel-meta">{provs.filter((p) => p.status === 'configured' || p.status === 'detected').length}/{provs.length} ready</span>
      </div>
      {list.loading && !list.data ? <div className="dash-empty">loading…</div>
        : provs.length === 0 ? <div className="dash-empty">no providers in catalog</div>
        : (
          <>
            <div className="dash-rows" data-testid={`${testId}-list`}>
              {provs.map((p) => (
                <div key={p.id}
                     className={`dash-row provider-row ${isActive(p) ? 'active' : ''}`}
                     data-testid={`provider-row-${p.id}`}>
                  <span className={`dash-row-status status-${p.status === 'configured' || p.status === 'detected' ? 'completed' : p.status === 'error' ? 'failed' : 'queued'}`}>
                    {p.status}
                  </span>
                  <span className="dash-row-title">
                    {p.name}{isActive(p) ? <span className="provider-active-pill">ACTIVE</span> : null}
                  </span>
                  <span className="dash-row-meta">{p.kind} · {p.models.length} {p.models.length === 1 ? 'model' : 'models'}</span>
                </div>
              ))}
            </div>
            <div className="provider-switcher">
              <select
                className="input"
                value={pendingProvider ?? ''}
                onChange={(e) => { setPendingProvider(e.target.value || null); setPendingModel(null) }}
                data-testid="provider-switcher-provider"
              >
                <option value="">— pick provider —</option>
                {provs.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.status === 'unconfigured' || p.status === 'error'}>
                    {p.name} · {p.status}
                  </option>
                ))}
              </select>
              <select
                className="input"
                value={pendingModel ?? ''}
                onChange={(e) => setPendingModel(e.target.value || null)}
                disabled={!selected}
                data-testid="provider-switcher-model"
              >
                <option value="">— pick model —</option>
                {selected?.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <button
                className="btn btn-primary"
                onClick={apply}
                disabled={busy || !pendingProvider || !pendingModel || (pendingProvider === active.data?.providerId && pendingModel === active.data?.modelId)}
                data-testid="provider-switcher-apply"
              >
                {busy ? 'saving…' : 'set active'}
              </button>
            </div>
            {error ? <div className="chat-msg-error">{error}</div> : null}
          </>
        )}
    </div>
  )
}

/**
 * Cost & usage at-a-glance. Backend doesn't track per-session totals yet
 * (deferred to add-chat-controls-multi-model), so the values here mirror
 * the statusbar's placeholder zeros — but they're surfaced prominently so
 * the operator sees where token + cost telemetry will land.
 */
function CostPanel({ testId }: { testId?: string }): JSX.Element {
  // Placeholders. Once the bridge tracks tokens/cost, swap to live data.
  const session = { in: 0, out: 0, ctxPct: 0, usd: 0, totalSessions: 0 }
  return (
    <div className="dash-panel" data-testid={testId}>
      <div className="dash-panel-head">
        <span className="kk-label-tiny">COST &amp; USAGE</span>
        <span className="dash-panel-meta">{session.totalSessions} sessions · current</span>
      </div>
      <div className="cost-grid">
        <div className="cost-cell" data-testid={`${testId}-in`}>
          <span className="cost-cell-label">TOKENS IN</span>
          <span className="cost-cell-value">{session.in.toLocaleString()}</span>
        </div>
        <div className="cost-cell" data-testid={`${testId}-out`}>
          <span className="cost-cell-label">TOKENS OUT</span>
          <span className="cost-cell-value">{session.out.toLocaleString()}</span>
        </div>
        <div className="cost-cell" data-testid={`${testId}-ctx`}>
          <span className="cost-cell-label">CONTEXT</span>
          <span className="cost-cell-value">{session.ctxPct}%</span>
        </div>
        <div className="cost-cell highlight" data-testid={`${testId}-usd`}>
          <span className="cost-cell-label">SESSION COST</span>
          <span className="cost-cell-value">${session.usd.toFixed(2)}</span>
        </div>
      </div>
      <div className="cost-note">
        Token + cost telemetry lands with the <code>add-chat-controls-multi-model</code>
        change. The pi bridge will surface usage data per run; this panel will then
        show live totals across the active session.
      </div>
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
        <CostPanel testId="dash-cost" />
        <ProvidersPanel testId="dash-providers" />
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
