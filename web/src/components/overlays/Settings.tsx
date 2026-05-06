import { useEffect, useState } from 'react'
import { useApi } from '../../hooks/useApi'
import { listProviders, getActiveProvider, setActiveProvider, type Provider } from '../../lib/api'

interface Props {
  open: boolean
  onClose: () => void
  vibe: string
  setVibe: (v: string) => void
}

const VIBES = [
  { id: 'default',  label: 'System default (dark)' },
  { id: 'light',    label: 'Light mode' },
  { id: 'terminal', label: 'Terminal / CRT' },
  { id: 'sre',      label: 'SRE Console' },
  { id: 'calm',     label: 'Editorial Calm' },
  { id: 'cyber',    label: 'Cyberpunk HUD' },
]

export function Settings({ open, onClose, vibe, setVibe }: Props): JSX.Element | null {
  const providers = useApi('settings.providers', listProviders)
  const active = useApi('settings.active', getActiveProvider)
  const [providerId, setProviderId] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (active.data) { setProviderId(active.data.providerId); setModelId(active.data.modelId) }
  }, [active.data])

  if (!open) return null
  const provs: Provider[] = providers.data?.providers ?? []
  const selectedProv = provs.find((p) => p.id === providerId)

  const save = async () => {
    if (!providerId || !modelId) return
    setBusy(true); setError(null); setSaved(false)
    try {
      await setActiveProvider(providerId, modelId)
      setSaved(true)
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <div className="kb-modal-shade" onClick={onClose}>
      <div className="kb-modal settings-modal" onClick={(e) => e.stopPropagation()} data-testid="settings-overlay">
        <div className="kb-editor-head">
          <h3>Settings</h3>
          <button className="btn btn-ghost" onClick={onClose}>×</button>
        </div>

        <div className="settings-section">
          <div className="kk-label-tiny">THEME / VIBE</div>
          <div className="settings-vibe-grid" data-testid="settings-vibe">
            {VIBES.map((v) => (
              <button key={v.id}
                className={`settings-vibe-btn ${vibe === v.id ? 'active' : ''}`}
                onClick={() => setVibe(v.id)}
                data-testid={`vibe-${v.id}`}>
                <span className="settings-vibe-name">{v.label}</span>
                <span className="settings-vibe-id">vibe-{v.id}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <div className="kk-label-tiny">PROVIDER + MODEL</div>
          <div className="settings-provider-row">
            <select className="input" value={providerId ?? ''} onChange={(e) => { setProviderId(e.target.value); setModelId(null) }} data-testid="settings-provider">
              <option value="">— pick provider —</option>
              {provs.map((p) => (
                <option key={p.id} value={p.id} disabled={p.status === 'unconfigured' || p.status === 'error'}>
                  {p.name} · {p.status}
                </option>
              ))}
            </select>
            <select className="input" value={modelId ?? ''} onChange={(e) => setModelId(e.target.value)} disabled={!selectedProv} data-testid="settings-model">
              <option value="">— pick model —</option>
              {selectedProv?.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          {error ? <div className="chat-msg-error">{error}</div> : null}
          {saved ? <div className="settings-saved" data-testid="settings-saved">saved · pi will use the new model on next chat send</div> : null}
        </div>

        <div className="kb-editor-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>close</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !providerId || !modelId} data-testid="settings-save">
            {busy ? 'saving…' : 'save provider'}
          </button>
        </div>
      </div>
    </div>
  )
}
