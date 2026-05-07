import { useState } from 'react'

import { useApi } from '../../hooks/useApi'
import {
  listMcpServers, listMcpTools,
  createMcpServer, deleteMcpServer,
  type McpServerInput,
} from '../../lib/api'

export function McpScreen(): JSX.Element {
  const servers = useApi('mcp.servers', () => listMcpServers(true))
  const tools = useApi('mcp.tools', listMcpTools)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const refresh = () => { servers.reload(); tools.reload() }

  const handleDelete = async (id: string) => {
    if (!window.confirm(`Remove MCP server "${id}"? Built-in (seed) servers can't be removed; you'll see an error if it isn't user-added.`)) return
    setBusy(true); setErr(null)
    try {
      await deleteMcpServer(id)
      refresh()
    } catch (e) { setErr((e as Error).message) }
    finally { setBusy(false) }
  }

  return (
    <div className="kb-screen" data-testid="mcp">
      <div className="kb-header">
        <h2>MCP</h2>
        <div className="kb-meta">{servers.data?.servers.length ?? 0} servers · {tools.data?.tools.length ?? 0} tools registered</div>
        <button className="btn btn-accent small" onClick={() => setAdding(true)} data-testid="mcp-add">+ Add MCP server</button>
        <button className="btn btn-ghost small" onClick={refresh} data-testid="mcp-refresh">refresh</button>
      </div>

      {err ? <div className="banner banner-error" data-testid="mcp-error" style={{ padding: '6px 16px' }}>{err}</div> : null}

      <div className="mcp-grid" data-testid="mcp-servers">
        {(servers.data?.servers ?? []).map((s) => (
          <div key={s.id} className="dash-card mcp-server" data-testid={`mcp-server-${s.id}`}>
            <div className="dash-card-label">{s.id} · {s.kind}</div>
            <div className="dash-card-value" style={{ fontSize: 14 }}>
              <span className={`mcp-pill mcp-${s.status}`}>{s.status}</span>
            </div>
            <div className="dash-card-hint">
              {s.toolCount} tools{s.error ? ` · ${s.error}` : ''}
            </div>
            <button
              className="btn btn-ghost small"
              disabled={busy}
              onClick={() => { void handleDelete(s.id) }}
              data-testid={`mcp-delete-${s.id}`}
              title='Remove (only user-added servers can be removed)'
              style={{ marginTop: 6, fontSize: 11 }}
            >Remove</button>
          </div>
        ))}
      </div>

      <div className="dash-panel" data-testid="mcp-tools">
        <div className="dash-panel-head">
          <span className="kk-label-tiny">REGISTERED TOOLS</span>
          <span className="dash-panel-meta">{tools.data?.tools.length ?? 0}</span>
        </div>
        {(tools.data?.tools ?? []).length === 0
          ? <div className="dash-empty">no MCP tools registered yet — connect a server above</div>
          : (
            <div className="dash-rows">
              {tools.data?.tools.map((t) => (
                <div key={t.qualifiedName} className="dash-row" data-testid={`mcp-tool-${t.qualifiedName}`}>
                  <span className="dash-row-status status-running">{t.serverId}</span>
                  <span className="dash-row-title">{t.toolName}</span>
                  <span className="dash-row-meta">{t.description?.slice(0, 80) ?? ''}</span>
                </div>
              ))}
            </div>
          )}
      </div>

      {adding ? (
        <McpAddModal
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); refresh() }}
        />
      ) : null}
    </div>
  )
}

interface AddProps { onClose: () => void; onSaved: () => void }

function McpAddModal({ onClose, onSaved }: AddProps): JSX.Element {
  const [kind, setKind] = useState<'stdio' | 'http'>('stdio')
  const [id, setId] = useState('')
  const [command, setCommand] = useState('uvx')
  const [argsText, setArgsText] = useState('')
  const [url, setUrl] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [envText, setEnvText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const parseKv = (text: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      const eq = t.indexOf('=')
      if (eq < 1) continue
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
    }
    return out
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setBusy(true)
    try {
      const trimmedId = id.trim()
      if (!/^[a-z][a-z0-9-]*$/.test(trimmedId)) throw new Error('id must be kebab-case (lowercase letters, digits, hyphen)')
      const input: McpServerInput = kind === 'stdio'
        ? {
            id: trimmedId, kind: 'stdio',
            command: command.trim() || 'uvx',
            args: argsText.split('\n').map((s) => s.trim()).filter(Boolean),
            env: Object.keys(parseKv(envText)).length > 0 ? parseKv(envText) : undefined,
          }
        : {
            id: trimmedId, kind: 'http',
            url: url.trim(),
            headers: Object.keys(parseKv(headersText)).length > 0 ? parseKv(headersText) : undefined,
          }
      if (input.kind === 'stdio' && input.args.length === 0) throw new Error('stdio servers need at least one arg')
      if (input.kind === 'http' && !input.url) throw new Error('url required for http servers')
      await createMcpServer(input)
      onSaved()
    } catch (ex) {
      setErr((ex as Error).message)
    } finally { setBusy(false) }
  }

  return (
    <div className="kb-modal-shade" onClick={onClose}>
      <form className="kb-modal" onClick={(e) => e.stopPropagation()} onSubmit={submit} data-testid="mcp-add-modal" style={{ maxWidth: 560 }}>
        <h3 style={{ margin: 0, marginBottom: 6 }}>Add MCP server</h3>
        <div className="kb-meta" style={{ fontSize: 11, marginBottom: 12 }}>
          Persisted in <code>{'<workspaceRoot>/mcp-servers.json'}</code>. Built-in (seed)
          servers — atlassian, ref, context7 — can't be modified from here.
        </div>

        <label className="kk-label-tiny">ID (kebab-case)</label>
        <input className="input mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="my-tool" data-testid="mcp-add-id" autoFocus />

        <label className="kk-label-tiny" style={{ marginTop: 8 }}>Kind</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <input type="radio" value="stdio" checked={kind === 'stdio'} onChange={() => setKind('stdio')} data-testid="mcp-add-kind-stdio" />
            stdio
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <input type="radio" value="http" checked={kind === 'http'} onChange={() => setKind('http')} data-testid="mcp-add-kind-http" />
            http
          </label>
        </div>

        {kind === 'stdio' ? (
          <>
            <label className="kk-label-tiny" style={{ marginTop: 8 }}>Command</label>
            <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="uvx" data-testid="mcp-add-command" />
            <label className="kk-label-tiny" style={{ marginTop: 8 }}>Args (one per line)</label>
            <textarea className="input mono" rows={4} value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={'-y\n@upstash/context7-mcp@latest'} data-testid="mcp-add-args" />
            <label className="kk-label-tiny" style={{ marginTop: 8 }}>Env (KEY=VALUE per line; optional)</label>
            <textarea className="input mono" rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={'FOO=bar\nBAZ=qux'} data-testid="mcp-add-env" />
          </>
        ) : (
          <>
            <label className="kk-label-tiny" style={{ marginTop: 8 }}>URL</label>
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/mcp" data-testid="mcp-add-url" />
            <label className="kk-label-tiny" style={{ marginTop: 8 }}>Headers (KEY=VALUE per line; optional)</label>
            <textarea className="input mono" rows={3} value={headersText} onChange={(e) => setHeadersText(e.target.value)} placeholder={'x-api-key=…'} data-testid="mcp-add-headers" />
          </>
        )}

        {err ? <div className="chat-msg-error" data-testid="mcp-add-error">{err}</div> : null}

        <div className="kb-editor-actions" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>cancel</button>
          <button type="submit" className="btn btn-accent" disabled={busy || !id.trim()} data-testid="mcp-add-submit">
            {busy ? 'adding…' : 'add'}
          </button>
        </div>
      </form>
    </div>
  )
}
