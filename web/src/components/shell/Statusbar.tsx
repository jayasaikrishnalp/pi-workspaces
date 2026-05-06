import type { ProbeResponse } from '../../lib/api'

interface Props {
  probe: ProbeResponse | null
  streaming?: boolean
  /**
   * Per-session token + cost telemetry. Backend doesn't track these yet
   * (deferred to add-chat-controls-multi-model), so the strip ships with
   * placeholder zeros — but it's always visible so operators see where
   * the data will land.
   */
  cost?: { in: number; out: number; ctxPct: number; usd: number }
}

const ZERO = { in: 0, out: 0, ctxPct: 0, usd: 0 }

export function Statusbar({ probe, streaming, cost = ZERO }: Props): JSX.Element {
  return (
    <div className="statusbar" data-testid="statusbar">
      <span className="item">
        <span className="pulse" /> hive · {probe?.pi.activeModel ?? probe?.pi.version ?? 'starting'}
      </span>
      <span className="item">{probe?.skills.count ?? 0} skills</span>
      <span className="item">{probe?.souls?.count ?? 0} souls</span>
      <span className="item">{probe?.jobs?.count ?? 0} jobs</span>
      <span className="item">{probe?.tasks?.count ?? 0} tasks</span>
      <span className="cost-strip" data-testid="cost-strip">
        <span className="cost-label">SESSION</span>
        <span className="cost-sep">|</span>
        <span className="cost-pair"><span className="cost-key">IN</span><span className="cost-val" data-testid="cost-in">{cost.in}</span></span>
        <span className="cost-pair"><span className="cost-key">OUT</span><span className="cost-val" data-testid="cost-out">{cost.out}</span></span>
        <span className="cost-pair"><span className="cost-key">CTX</span><span className="cost-val" data-testid="cost-ctx">{cost.ctxPct}%</span></span>
        <span className="cost-pair"><span className="cost-key">COST</span><span className="cost-val" data-testid="cost-usd">${cost.usd.toFixed(2)}</span></span>
      </span>
      <div className="right">
        <span className="item">{streaming ? 'streaming' : 'idle'}</span>
        <span className="item">heartbeat 30s</span>
        <span className="item">⌘K cmd</span>
        <span className="item">v0.3.0</span>
      </div>
    </div>
  )
}
