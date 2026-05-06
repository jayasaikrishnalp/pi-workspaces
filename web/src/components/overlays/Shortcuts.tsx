interface Props { open: boolean; onClose: () => void }

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['⌘', 'K'], label: 'Open command palette' },
  { keys: ['⌘', ','], label: 'Open settings' },
  { keys: ['?'],      label: 'Open this shortcuts overlay' },
  { keys: ['⌘', 'B'], label: 'Toggle sidebar collapse' },
  { keys: ['⌘', 'Enter'], label: 'Send message in chat' },
  { keys: ['Esc'],    label: 'Close any overlay' },
]

export function Shortcuts({ open, onClose }: Props): JSX.Element | null {
  if (!open) return null
  return (
    <div className="kb-modal-shade" onClick={onClose}>
      <div className="kb-modal" onClick={(e) => e.stopPropagation()} data-testid="shortcuts-overlay">
        <div className="kb-editor-head"><h3>Keyboard shortcuts</h3><button className="btn btn-ghost" onClick={onClose}>×</button></div>
        <div className="shortcuts-list">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="shortcuts-row">
              <span>{s.label}</span>
              <span className="shortcuts-keys">{s.keys.map((k) => <kbd key={k}>{k}</kbd>)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
