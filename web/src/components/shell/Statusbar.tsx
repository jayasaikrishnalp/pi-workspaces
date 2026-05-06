import type { ProbeResponse } from '../../lib/api'

interface Props {
  probe: ProbeResponse | null
  streaming?: boolean
}

export function Statusbar({ probe, streaming }: Props): JSX.Element {
  return (
    <div className="statusbar" data-testid="statusbar">
      <span className="item">
        <span className="pulse" /> hive · {probe?.pi.activeModel ?? probe?.pi.version ?? 'starting'}
      </span>
      <span className="item">{probe?.skills.count ?? 0} skills</span>
      <span className="item">{probe?.souls?.count ?? 0} souls</span>
      <span className="item">{probe?.jobs?.count ?? 0} jobs</span>
      <span className="item">{probe?.tasks?.count ?? 0} tasks</span>
      <div className="right">
        <span className="item">{streaming ? 'streaming' : 'idle'}</span>
        <span className="item">heartbeat 30s</span>
        <span className="item">⌘K cmd</span>
        <span className="item">v0.2.0</span>
      </div>
    </div>
  )
}
