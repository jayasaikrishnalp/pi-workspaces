import { useCallback, useEffect, useState } from 'react'

import { listSecrets, putSecret, deleteSecret, type SecretEntry } from '../../lib/api'

const AWS_PRESET = [
  { key: 'aws.access_key_id', label: 'Access Key ID', placeholder: 'AKIA...' },
  { key: 'aws.secret_access_key', label: 'Secret Access Key', placeholder: 'wJalrXUtnFEMI/...' },
  { key: 'aws.session_token', label: 'Session Token (optional)', placeholder: '' },
  { key: 'aws.region', label: 'Default Region', placeholder: 'us-east-1' },
] as const

const AZURE_PRESET = [
  { key: 'azure.client_id', label: 'Client ID', placeholder: '00000000-0000-...' },
  { key: 'azure.client_secret', label: 'Client Secret', placeholder: '' },
  { key: 'azure.tenant_id', label: 'Tenant ID', placeholder: '00000000-0000-...' },
  { key: 'azure.subscription_id', label: 'Subscription ID', placeholder: '00000000-0000-...' },
] as const

const ATLASSIAN_PRESET = [
  { key: 'confluence.base_url', label: 'Confluence Base URL', placeholder: 'https://your-org.atlassian.net' },
  { key: 'jira.email', label: 'Email', placeholder: 'you@your-org.com' },
  { key: 'jira.token', label: 'API Token', placeholder: 'ATATT3x...' },
] as const

type PresetField = { key: string; label: string; placeholder: string }

function formatTime(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString()
}

export function SecretsScreen(): JSX.Element {
  const [rows, setRows] = useState<SecretEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Single-pair add form
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  // Preset form (one of: null | 'aws' | 'azure')
  const [preset, setPreset] = useState<null | 'aws' | 'azure' | 'atlassian'>(null)
  const [presetValues, setPresetValues] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const r = await listSecrets()
      setRows(r.secrets)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const submitSingle = async () => {
    if (!newKey.trim() || !newValue) return
    setBusy(true); setErr(null)
    try {
      await putSecret(newKey.trim(), newValue)
      setNewKey(''); setNewValue('')
      await refresh()
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  const submitPreset = async () => {
    if (!preset) return
    const fields: readonly PresetField[] =
      preset === 'aws' ? AWS_PRESET
      : preset === 'azure' ? AZURE_PRESET
      : ATLASSIAN_PRESET
    setBusy(true); setErr(null)
    try {
      for (const f of fields) {
        const v = (presetValues[f.key] ?? '').trim()
        if (!v) continue
        await putSecret(f.key, v)
      }
      setPreset(null); setPresetValues({})
      await refresh()
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  const remove = async (key: string) => {
    if (!window.confirm(`Delete secret "${key}"? This cannot be undone.`)) return
    setBusy(true); setErr(null)
    try {
      await deleteSecret(key)
      await refresh()
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  const presetFields: readonly PresetField[] | null =
    preset === 'aws' ? AWS_PRESET
    : preset === 'azure' ? AZURE_PRESET
    : preset === 'atlassian' ? ATLASSIAN_PRESET
    : null
  const presetTitle =
    preset === 'aws' ? 'AWS credentials'
    : preset === 'azure' ? 'Azure service principal'
    : preset === 'atlassian' ? 'Jira / Confluence'
    : ''

  return (
    <div className="kb-screen secrets-screen" data-testid="secrets">
      <div className="kb-header">
        <h2>Secrets</h2>
        <div className="kb-meta">
          credentials injected as environment variables into pi + MCP servers
        </div>
      </div>

      {err ? <div className="banner banner-error">{err}</div> : null}

      <div className="secrets-presets">
        <button
          type="button"
          className="btn btn-accent"
          onClick={() => { setPreset('aws'); setPresetValues({}) }}
          data-testid="secrets-preset-aws"
        >+ Add AWS credentials</button>
        <button
          type="button"
          className="btn btn-accent"
          onClick={() => { setPreset('azure'); setPresetValues({}) }}
          data-testid="secrets-preset-azure"
        >+ Add Azure SP</button>
        <button
          type="button"
          className="btn btn-accent"
          onClick={() => { setPreset('atlassian'); setPresetValues({}) }}
          data-testid="secrets-preset-atlassian"
        >+ Add Jira / Confluence</button>
      </div>

      {presetFields ? (
        <div className="secrets-preset-form" data-testid={`secrets-preset-${preset}`}>
          <h3>{presetTitle}</h3>
          {presetFields.map((f) => (
            <div className="secrets-preset-row" key={f.key}>
              <label>{f.label}</label>
              <code className="secrets-preset-key">{f.key}</code>
              <input
                type="password"
                placeholder={f.placeholder}
                value={presetValues[f.key] ?? ''}
                onChange={(e) => setPresetValues((s) => ({ ...s, [f.key]: e.target.value }))}
                data-testid={`secrets-preset-input-${f.key}`}
              />
            </div>
          ))}
          <div className="secrets-preset-actions">
            <button
              type="button"
              className="btn btn-accent"
              disabled={busy}
              onClick={() => { void submitPreset() }}
              data-testid="secrets-preset-submit"
            >Save</button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => { setPreset(null); setPresetValues({}) }}
            >Cancel</button>
          </div>
        </div>
      ) : null}

      <div className="secrets-add">
        <h3>Add secret</h3>
        <div className="secrets-add-row">
          <input
            type="text"
            placeholder="key (e.g. custom.api_token)"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            data-testid="secrets-add-key"
          />
          <input
            type="password"
            placeholder="value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            data-testid="secrets-add-value"
          />
          <button
            type="button"
            className="btn btn-accent"
            disabled={busy || !newKey.trim() || !newValue}
            onClick={() => { void submitSingle() }}
            data-testid="secrets-add-submit"
          >Save</button>
        </div>
      </div>

      <div className="secrets-list">
        <h3>Stored secrets {rows.length > 0 ? <span className="kb-meta">({rows.length})</span> : null}</h3>
        {loading && rows.length === 0 ? <div className="dash-empty">loading…</div>
          : rows.length === 0 ? (
            <div className="dash-empty" data-testid="secrets-empty">
              No secrets yet — add AWS or Azure credentials above to start.
            </div>
          ) : (
            <table className="jobs-table" data-testid="secrets-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} data-testid={`secrets-row-${r.key}`}>
                    <td className="mono">{r.key}</td>
                    <td className="mono small">{formatTime(r.updatedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost small"
                        onClick={() => { void remove(r.key) }}
                        data-testid={`secrets-delete-${r.key}`}
                      >Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </div>
  )
}
