import { useApi } from '../../hooks/useApi'
import { listSessions } from '../../lib/api'
import type { ScreenId } from '../Sidebar'

interface Props { onPick?: (id: ScreenId) => void }

export function SessionsScreen({ onPick }: Props = {}): JSX.Element {
  const { data, loading, reload } = useApi('sessions.list', listSessions)
  const sessions = (data?.sessions ?? []).slice().sort((a, b) => b.createdAt - a.createdAt)

  return (
    <div className="kb-screen" data-testid="sessions">
      <div className="kb-header">
        <h2>Sessions</h2>
        <div className="kb-meta">{sessions.length} on disk · live in-memory list of chat sessions</div>
        <button className="btn btn-ghost" onClick={reload} data-testid="sessions-refresh">refresh</button>
      </div>
      {loading && sessions.length === 0 ? <div className="dash-empty">loading…</div>
        : sessions.length === 0 ? <div className="dash-empty" data-testid="sessions-empty">no sessions yet — start a chat to create one</div>
        : (
          <table className="jobs-table" data-testid="sessions-table">
            <thead><tr><th>session key</th><th>created</th><th></th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionKey} data-testid={`session-row-${s.sessionKey}`}>
                  <td className="mono small">{s.sessionKey}</td>
                  <td className="mono small">{new Date(s.createdAt).toLocaleString()}</td>
                  <td>
                    <button className="btn btn-accent small" onClick={() => onPick?.('chat')} data-testid={`session-open-${s.sessionKey}`}>open chat →</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  )
}
