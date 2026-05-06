import { useApi } from '../../hooks/useApi'
import { listJobs, cancelJob, type Job } from '../../lib/api'

export function JobsScreen(): JSX.Element {
  const { data, loading, reload } = useApi('jobs.list', () => listJobs({ limit: 100 }))
  const jobs = data?.jobs ?? []

  const onCancel = async (id: string) => {
    try { await cancelJob(id); reload() } catch (e) { alert((e as Error).message) }
  }

  return (
    <div className="kb-screen" data-testid="jobs">
      <div className="kb-header">
        <h2>Jobs</h2>
        <div className="kb-meta">{jobs.length} on disk · one Job per chat send (created by /api/sessions/:k/send-stream)</div>
        <button className="btn btn-ghost" onClick={reload} data-testid="jobs-refresh">refresh</button>
      </div>
      {loading && jobs.length === 0 ? <div className="dash-empty">loading…</div>
        : jobs.length === 0
          ? <div className="dash-empty" data-testid="jobs-empty">no jobs yet — start a chat session to create one</div>
          : (
            <table className="jobs-table" data-testid="jobs-table">
              <thead>
                <tr><th>status</th><th>title</th><th>source</th><th>created</th><th>duration</th><th></th></tr>
              </thead>
              <tbody>
                {jobs.map((j: Job) => (
                  <tr key={j.id} data-testid={`job-row-${j.id}`}>
                    <td><span className={`dash-row-status status-${j.status}`}>{j.status}</span></td>
                    <td className="mono">{j.title ?? j.id.slice(0, 8)}</td>
                    <td>{j.source}</td>
                    <td className="mono small">{new Date(j.created_at).toLocaleString()}</td>
                    <td className="mono small">{j.completed_at ? `${((j.completed_at - j.created_at) / 1000).toFixed(1)}s` : '—'}</td>
                    <td>
                      {(j.status === 'queued' || j.status === 'running') ? (
                        <button className="btn btn-danger small" onClick={() => onCancel(j.id)} data-testid={`job-cancel-${j.id}`}>cancel</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
    </div>
  )
}
