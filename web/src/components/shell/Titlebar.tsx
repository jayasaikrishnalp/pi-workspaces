import { Icons } from '../icons/Icons'

interface Props {
  crumbs: string[]
  onCmdK?: () => void
  onShortcuts?: () => void
  onSettings?: () => void
}

export function Titlebar({ crumbs, onCmdK, onShortcuts, onSettings }: Props): JSX.Element {
  return (
    <div className="titlebar" data-testid="titlebar">
      <div className="traffic"><span className="red"/><span className="yellow"/><span className="green"/></div>
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <span key={i} className={i === crumbs.length - 1 ? 'active' : ''}>
            {c}
            {i < crumbs.length - 1 ? <span className="sep">/</span> : null}
          </span>
        ))}
      </div>
      <div className="right">
        <button className="cmdk" onClick={() => onCmdK?.()} data-testid="cmdk-button">
          <Icons.search size={11}/> search or jump…
          <kbd>⌘K</kbd>
        </button>
        <button className="btn btn-ghost" title="Notifications" style={{ height: 24, padding: '0 6px' }}>
          <Icons.bell size={13}/>
        </button>
        <button className="btn btn-ghost" title="Help (?)" onClick={() => onShortcuts?.()} style={{ height: 24, padding: '0 6px' }}>
          <Icons.question size={13}/>
        </button>
        <button className="btn btn-ghost" title="Settings (⌘,)" onClick={() => onSettings?.()} style={{ height: 24, padding: '0 6px' }}>
          <Icons.settings size={13}/>
        </button>
      </div>
    </div>
  )
}
