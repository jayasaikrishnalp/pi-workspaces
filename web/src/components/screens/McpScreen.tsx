import { useApi } from '../../hooks/useApi'
import { listMcpServers, listMcpTools } from '../../lib/api'

export function McpScreen(): JSX.Element {
  const servers = useApi('mcp.servers', () => listMcpServers(true))
  const tools = useApi('mcp.tools', listMcpTools)

  return (
    <div className="kb-screen" data-testid="mcp">
      <div className="kb-header">
        <h2>MCP</h2>
        <div className="kb-meta">{servers.data?.servers.length ?? 0} servers · {tools.data?.tools.length ?? 0} tools registered</div>
        <button className="btn btn-ghost" onClick={() => { servers.reload(); tools.reload() }} data-testid="mcp-refresh">refresh</button>
      </div>

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
    </div>
  )
}
