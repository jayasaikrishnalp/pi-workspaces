import { useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { execTerminal, listTerminalExecutions, type TerminalRow } from '../../lib/api'

export function TerminalScreen(): JSX.Element {
  const list = useApi('terminal.executions', () => listTerminalExecutions(50))
  const [command, setCommand] = useState('')
  const [running, setRunning] = useState(false)
  const [last, setLast] = useState<{ stdout: string; stderr: string; exitCode: number | null; status: string; durationMs: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!command.trim() || running) return
    setRunning(true); setError(null); setLast(null)
    try {
      const res = await execTerminal(command)
      setLast({ stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, status: res.status, durationMs: res.durationMs })
      setCommand('')
      list.reload()
    } catch (err) { setError((err as Error).message) }
    finally { setRunning(false) }
  }

  return (
    <div className="kb-screen" data-testid="terminal">
      <div className="kb-header">
        <h2>Terminal</h2>
        <div className="kb-meta">one-shot bash command runner · 1 MB output cap · 60s default timeout · audit-logged</div>
      </div>
      <form className="terminal-form" onSubmit={submit} data-testid="terminal-form">
        <span className="terminal-prompt">$</span>
        <input
          className="input terminal-input"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder='echo "hello" | cat -n'
          disabled={running}
          data-testid="terminal-input"
        />
        <button className="btn btn-primary" type="submit" disabled={running || !command.trim()} data-testid="terminal-run">
          {running ? 'running…' : 'run'}
        </button>
      </form>
      {error ? <div className="chat-msg-error">{error}</div> : null}
      {last ? (
        <div className="terminal-output" data-testid="terminal-output">
          <div className="terminal-output-head">
            <span className={`dash-row-status status-${last.status}`}>{last.status}</span>
            <span>exit {last.exitCode ?? '—'}</span>
            <span>{(last.durationMs / 1000).toFixed(2)}s</span>
          </div>
          {last.stdout ? <pre className="tool-card-pre" data-testid="terminal-stdout">{last.stdout}</pre> : null}
          {last.stderr ? <pre className="tool-card-pre terminal-stderr" data-testid="terminal-stderr">{last.stderr}</pre> : null}
        </div>
      ) : null}

      <div className="terminal-audit" data-testid="terminal-audit">
        <div className="kk-label-tiny">AUDIT LOG ({list.data?.executions.length ?? 0})</div>
        {list.data?.executions.length === 0
          ? <div className="dash-empty">no commands run yet</div>
          : (
            <table className="jobs-table">
              <thead><tr><th>status</th><th>command</th><th>exit</th><th>duration</th><th>when</th></tr></thead>
              <tbody>
                {list.data?.executions.map((r: TerminalRow) => (
                  <tr key={r.id} data-testid={`audit-row-${r.id}`}>
                    <td><span className={`dash-row-status status-${r.status}`}>{r.status}</span></td>
                    <td className="mono small" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.command}</td>
                    <td className="mono small">{r.exit_code ?? '—'}</td>
                    <td className="mono small">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(2)}s` : '—'}</td>
                    <td className="mono small">{new Date(r.started_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  )
}
