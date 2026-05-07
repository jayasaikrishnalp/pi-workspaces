/**
 * JobsScreen — backend-recorded job list (one per chat send) plus a
 * frontend-only "Scheduled Jobs" register backed by localStorage.
 *
 * Scheduling backend isn't in place yet, so scheduled jobs are stored
 * locally as drafts. The Create Job modal mirrors the Hermes design:
 * Name → schedule chips (or custom cron) → prompt → skills → save.
 *
 * "Run now" on a scheduled draft pipes its prompt + skills into a chat
 * session via window dispatch — pi picks it up via the chat composer.
 */
import { useEffect, useState } from 'react'

import { Icons } from '../icons/Icons'
import { useApi } from '../../hooks/useApi'
import { listJobs, cancelJob, type Job } from '../../lib/api'
import './jobs-screen.css'

const SCHEDULED_KEY = 'hive.scheduled-jobs.v1'

interface ScheduledJob {
  id: string
  name: string
  cron: string
  preset: string | null
  prompt: string
  skills: string[]
  routeToTeam: string | null
  repeat: boolean
  createdAt: number
}

const SCHEDULE_PRESETS = [
  { label: 'Every 15m', cron: '*/15 * * * *' },
  { label: 'Every 30m', cron: '*/30 * * * *' },
  { label: 'Every 1h',  cron: '0 * * * *' },
  { label: 'Every 6h',  cron: '0 */6 * * *' },
  { label: 'Daily',     cron: '0 9 * * *' },
  { label: 'Weekly',    cron: '0 9 * * 1' },
] as const

const PROMPT_TEMPLATES = [
  {
    name: 'Check for new skills',
    description: 'Scan the local skills directory and the wiki KB for new SKILL.md files since the last run; summarise additions, deletions and edits.',
    prompt:
      'Check the skills knowledge base for any new or updated skills. Walk both the local repo `seed-skills/skills/` and the wiki `~/pipeline-information/wiki/skills/`. Summarise:\n' +
      '  • new skills added since yesterday\n' +
      '  • skills updated (frontmatter or body changes)\n' +
      '  • skills missing from one source but present in the other\n' +
      'Output a short markdown report; flag anything that needs review.',
    skills: ['skill-creator'],
    preset: 'Daily',
  },
] as const

function loadScheduled(): ScheduledJob[] {
  try {
    const raw = localStorage.getItem(SCHEDULED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ScheduledJob[]
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function saveScheduled(jobs: ScheduledJob[]): void {
  try { localStorage.setItem(SCHEDULED_KEY, JSON.stringify(jobs)) } catch { /* ignore */ }
}

export function JobsScreen(): JSX.Element {
  const { data, loading, reload } = useApi('jobs.list', () => listJobs({ limit: 100 }))
  const jobs = data?.jobs ?? []

  const [scheduled, setScheduled] = useState<ScheduledJob[]>(loadScheduled)
  const [creating, setCreating] = useState(false)

  useEffect(() => { saveScheduled(scheduled) }, [scheduled])

  const onCancel = async (id: string) => {
    try { await cancelJob(id); reload() } catch (e) { alert((e as Error).message) }
  }

  const onCreate = (job: ScheduledJob) => {
    setScheduled((prev) => [job, ...prev])
    setCreating(false)
  }

  const onDeleteScheduled = (id: string) => {
    setScheduled((prev) => prev.filter((j) => j.id !== id))
  }

  const onRunNow = (job: ScheduledJob) => {
    // Hand off to the Chat surface — pi receives the prompt as if the user
    // typed it. Other surfaces can subscribe to this CustomEvent if needed.
    window.dispatchEvent(new CustomEvent('hive:run-job', { detail: { prompt: job.prompt, skills: job.skills, name: job.name } }))
  }

  return (
    <div className="jobs-screen" data-testid="jobs">
      <header className="jobs-header">
        <div className="jobs-header-titles">
          <h2 className="jobs-title">Jobs</h2>
          <div className="jobs-sub">
            {jobs.length} recent · {scheduled.length} scheduled
          </div>
        </div>
        <div className="jobs-header-actions">
          <button className="jobs-action-btn" onClick={reload} data-testid="jobs-refresh">
            <Icons.history size={12} /> Refresh
          </button>
          <button
            className="jobs-action-btn jobs-action-primary"
            onClick={() => setCreating(true)}
            data-testid="jobs-new"
          >
            <Icons.plus size={12} /> New Job
          </button>
        </div>
      </header>

      <div className="jobs-body">
        {/* Scheduled jobs (local drafts). Always render the header so the user
            knows where they live, even when empty. */}
        <section className="jobs-section">
          <div className="jobs-section-head">
            <span className="jobs-section-title">Scheduled</span>
            <span className="jobs-section-meta">stored locally · scheduling backend pending</span>
          </div>
          {scheduled.length === 0 ? (
            <div className="jobs-empty-card">
              <Icons.spark size={14} />
              <span>No scheduled jobs yet — click "New Job" to create one.</span>
            </div>
          ) : (
            <div className="jobs-grid">
              {scheduled.map((j) => (
                <article className="jobs-card" key={j.id} data-testid={`scheduled-job-${j.id}`}>
                  <div className="jobs-card-head">
                    <span className="jobs-card-icon"><Icons.jobs size={14} /></span>
                    <div className="jobs-card-titles">
                      <div className="jobs-card-name">{j.name}</div>
                      <div className="jobs-card-cron">
                        {j.preset ?? 'cron'} · <code>{j.cron}</code>
                      </div>
                    </div>
                  </div>
                  <div className="jobs-card-prompt">{j.prompt}</div>
                  {j.skills.length > 0 ? (
                    <div className="jobs-card-skills">
                      {j.skills.map((s) => (
                        <span key={s} className="jobs-card-skill-chip">{s}</span>
                      ))}
                    </div>
                  ) : null}
                  <div className="jobs-card-foot">
                    <button
                      className="jobs-card-btn jobs-card-btn-primary"
                      onClick={() => onRunNow(j)}
                      data-testid={`scheduled-run-${j.id}`}
                    >
                      ▸ Run now
                    </button>
                    <button
                      className="jobs-card-btn"
                      onClick={() => {
                        if (window.confirm(`Delete scheduled job "${j.name}"?`)) onDeleteScheduled(j.id)
                      }}
                      data-testid={`scheduled-delete-${j.id}`}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Recent (backend) jobs — keep the existing table. */}
        <section className="jobs-section">
          <div className="jobs-section-head">
            <span className="jobs-section-title">Recent runs</span>
            <span className="jobs-section-meta">one Job per chat send</span>
          </div>
          {loading && jobs.length === 0 ? (
            <div className="jobs-empty-card">loading…</div>
          ) : jobs.length === 0 ? (
            <div className="jobs-empty-card" data-testid="jobs-empty">No runs yet — start a chat session to create one.</div>
          ) : (
            <div className="jobs-table-wrap">
              <table className="jobs-table" data-testid="jobs-table">
                <thead>
                  <tr><th>status</th><th>title</th><th>source</th><th>created</th><th>duration</th><th></th></tr>
                </thead>
                <tbody>
                  {jobs.map((j: Job) => (
                    <tr key={j.id} data-testid={`job-row-${j.id}`}>
                      <td><span className={`jobs-status status-${j.status}`}>{j.status}</span></td>
                      <td className="mono">{j.title ?? j.id.slice(0, 8)}</td>
                      <td className="jobs-table-source">{j.source}</td>
                      <td className="mono small">{new Date(j.created_at).toLocaleString()}</td>
                      <td className="mono small">{j.completed_at ? `${((j.completed_at - j.created_at) / 1000).toFixed(1)}s` : '—'}</td>
                      <td>
                        {(j.status === 'queued' || j.status === 'running') ? (
                          <button className="jobs-table-cancel" onClick={() => onCancel(j.id)} data-testid={`job-cancel-${j.id}`}>cancel</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {creating ? (
        <CreateJobModal onClose={() => setCreating(false)} onCreate={onCreate} />
      ) : null}
    </div>
  )
}

interface CreateJobModalProps {
  onClose: () => void
  onCreate: (job: ScheduledJob) => void
}

function CreateJobModal({ onClose, onCreate }: CreateJobModalProps): JSX.Element {
  const [name, setName] = useState('')
  const [preset, setPreset] = useState<string | null>('Daily')
  const [cron, setCron] = useState('0 9 * * *')
  const [prompt, setPrompt] = useState('')
  const [skills, setSkills] = useState('')
  const [routeToTeam, setRouteToTeam] = useState('')
  const [repeat, setRepeat] = useState(true)

  const pickPreset = (p: typeof SCHEDULE_PRESETS[number]) => {
    setPreset(p.label)
    setCron(p.cron)
  }

  const onCustomCron = (v: string) => {
    setCron(v)
    // If the user hand-edits the cron, the preset is no longer the source.
    const matched = SCHEDULE_PRESETS.find((p) => p.cron === v.trim())
    setPreset(matched?.label ?? null)
  }

  const applyTemplate = (t: typeof PROMPT_TEMPLATES[number]) => {
    if (!name) setName(t.name)
    setPrompt(t.prompt)
    setSkills(t.skills.join(', '))
    const matched = SCHEDULE_PRESETS.find((p) => p.label === t.preset)
    if (matched) {
      setPreset(matched.label)
      setCron(matched.cron)
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !prompt.trim() || !cron.trim()) return
    const job: ScheduledJob = {
      id: 'sj-' + Math.random().toString(36).slice(2, 10),
      name: name.trim(),
      cron: cron.trim(),
      preset,
      prompt: prompt.trim(),
      skills: skills.split(',').map((s) => s.trim()).filter(Boolean),
      routeToTeam: routeToTeam.trim() || null,
      repeat,
      createdAt: Date.now(),
    }
    onCreate(job)
  }

  return (
    <div className="jobs-modal-shade" onClick={onClose} data-testid="job-create-modal">
      <form className="jobs-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="jobs-modal-head">
          <div>
            <h3 className="jobs-modal-title">Create Job</h3>
            <div className="jobs-modal-sub">Build a scheduled Hermes task with preset timing options.</div>
          </div>
          <button type="button" className="jobs-modal-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="jobs-modal-body">
          {PROMPT_TEMPLATES.length > 0 ? (
            <section className="jobs-modal-section jobs-templates">
              <div className="jobs-modal-section-head">
                <span className="jobs-modal-label">Templates</span>
                <span className="jobs-modal-hint">Quick-fill from a preset</span>
              </div>
              <div className="jobs-template-row">
                {PROMPT_TEMPLATES.map((t) => (
                  <button
                    key={t.name}
                    type="button"
                    className="jobs-template-btn"
                    onClick={() => applyTemplate(t)}
                    data-testid={`job-template-${t.name.replace(/\s+/g, '-').toLowerCase()}`}
                    title={t.description}
                  >
                    <Icons.spark size={11} /> {t.name}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <section className="jobs-modal-section">
            <label className="jobs-modal-label" htmlFor="job-name">Name</label>
            <input
              id="job-name"
              className="jobs-modal-input"
              type="text"
              placeholder="Daily research summary"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              data-testid="job-create-name"
            />
          </section>

          <section className="jobs-modal-section">
            <div className="jobs-modal-section-head">
              <span className="jobs-modal-label">Schedule</span>
              <span className="jobs-modal-hint">Choose a preset or enter a custom schedule string below.</span>
            </div>
            <div className="jobs-schedule-chips" data-testid="job-schedule-chips">
              {SCHEDULE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`jobs-schedule-chip ${preset === p.label ? 'is-active' : ''}`}
                  onClick={() => pickPreset(p)}
                  data-testid={`job-preset-${p.label.replace(/\s+/g, '-').toLowerCase()}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </section>

          <section className="jobs-modal-section">
            <label className="jobs-modal-label" htmlFor="job-cron">Custom schedule</label>
            <input
              id="job-cron"
              className="jobs-modal-input jobs-modal-input--mono"
              type="text"
              placeholder="0 9 * * *"
              value={cron}
              onChange={(e) => onCustomCron(e.target.value)}
              data-testid="job-create-cron"
            />
            <div className="jobs-modal-hint">Advanced users can enter cron expressions directly.</div>
          </section>

          <section className="jobs-modal-section">
            <label className="jobs-modal-label" htmlFor="job-prompt">Prompt</label>
            <textarea
              id="job-prompt"
              className="jobs-modal-textarea"
              rows={5}
              placeholder="What should Hermes Agent do?"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              data-testid="job-create-prompt"
            />
          </section>

          <section className="jobs-modal-section">
            <div className="jobs-modal-section-head">
              <span className="jobs-modal-label">Options</span>
              <span className="jobs-modal-hint">Optional routing and repeat controls.</span>
            </div>

            <label className="jobs-modal-label jobs-modal-sublabel" htmlFor="job-skills">Skills</label>
            <input
              id="job-skills"
              className="jobs-modal-input"
              type="text"
              placeholder="research, writing, synthesis"
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
              data-testid="job-create-skills"
            />

            <label className="jobs-modal-label jobs-modal-sublabel" htmlFor="job-team">Route to team (optional)</label>
            <input
              id="job-team"
              className="jobs-modal-input"
              type="text"
              placeholder="cloudops, data-platform, …"
              value={routeToTeam}
              onChange={(e) => setRouteToTeam(e.target.value)}
              data-testid="job-create-team"
            />

            <label className="jobs-modal-checkbox">
              <input
                type="checkbox"
                checked={repeat}
                onChange={(e) => setRepeat(e.target.checked)}
                data-testid="job-create-repeat"
              />
              <span>Repeat on the schedule above (uncheck for a one-shot run)</span>
            </label>
          </section>
        </div>

        <footer className="jobs-modal-foot">
          <button type="button" className="jobs-modal-btn" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className="jobs-modal-btn jobs-modal-btn-primary"
            disabled={!name.trim() || !prompt.trim() || !cron.trim()}
            data-testid="job-create-submit"
          >Create</button>
        </footer>
      </form>
    </div>
  )
}
