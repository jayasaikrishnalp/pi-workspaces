import { useState } from 'react'
import { login } from '../lib/api'
import { Logo } from './icons/Icons'

interface Props {
  onLoggedIn: () => void
}

export function Login({ onLoggedIn }: Props): JSX.Element {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null); setBusy(true)
    try {
      await login(token)
      onLoggedIn()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit} data-testid="login-form">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Logo size={24}/> <h1>Hive Workspace</h1>
        </div>
        <p>Paste your dev token to unlock the workspace. The token is stored in your `~/.pi-workspace/dev-token.txt` and surfaced by `start.sh`.</p>
        <input
          className="input"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="dev token"
          autoFocus
          data-testid="login-token"
        />
        {error ? <span className="login-error" data-testid="login-error">{error}</span> : null}
        <button className="btn btn-primary" type="submit" disabled={busy || !token} data-testid="login-submit">
          {busy ? 'unlocking…' : 'unlock workspace'}
        </button>
      </form>
    </div>
  )
}
