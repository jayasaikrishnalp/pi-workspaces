import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

interface Props {
  onSend: (text: string) => void | Promise<void>
  disabled?: boolean
  streaming?: boolean
  /** Optional text seeded by an external trigger (e.g. quick-action chips). */
  seed?: string
  /** Bumped whenever a fresh seed should be applied (even if seed text is unchanged). */
  seedNonce?: number
  /** Click handler for the model-switch hotkey (⌘. / Ctrl+.). */
  onSwitchModel?: () => void
  /** Click handler for the stop button (only rendered while `streaming` is true). */
  onAbort?: () => void
}

export function Composer({
  onSend,
  disabled,
  streaming,
  seed,
  seedNonce,
  onSwitchModel,
  onAbort,
}: Props): JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Apply external seed (chip click) — focus and place caret at end.
  useEffect(() => {
    if (seed === undefined) return
    setValue(seed)
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(seed.length, seed.length)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce])

  const submit = async () => {
    // Block all submits while a run is in flight; the user must hit stop first.
    if (!value.trim() || busy || disabled || streaming) return
    setBusy(true)
    const v = value
    setValue('')
    try { await onSend(v) } finally { setBusy(false) }
  }

  const onSubmit = (e: FormEvent) => { e.preventDefault(); void submit() }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // ⌘. / Ctrl+. → switch model
    if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onSwitchModel?.()
      return
    }
    // Enter → send. Shift+Enter → newline (default). ⌘+Enter still sends.
    // Suppress Enter while streaming so it can't double-fire mid-run.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (streaming) return
      void submit()
    }
  }

  const placeholder = streaming
    ? 'streaming response…'
    : 'Ask anything…  (↵ send · ⇧↵ newline · ⌘. switch model)'

  return (
    <form className="composer composer-v2" onSubmit={onSubmit} data-testid="composer">
      <div className="composer-shell">
        <textarea
          ref={taRef}
          className="composer-text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          rows={1}
          disabled={disabled}
          data-testid="composer-text"
        />
        <div className="composer-row">
          <div className="composer-tools">
            {/* Paperclip removed until file-upload backend exists. */}
            <button
              type="button"
              className="composer-icon-btn"
              title="Open settings (⌘,)"
              aria-label="Open settings"
              onClick={() => {
                // App.tsx listens globally for Cmd/Ctrl+, → opens Settings.
                // Dispatching the keyboard event keeps this button decoupled
                // from the App component without prop-drilling onSettings.
                const ev = new KeyboardEvent('keydown', {
                  key: ',',
                  metaKey: true,
                  ctrlKey: true,
                  bubbles: true,
                })
                window.dispatchEvent(ev)
                onSwitchModel?.()
              }}
              data-testid="composer-settings"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="6" x2="20" y2="6"/>
                <circle cx="14" cy="6" r="2.2" fill="currentColor"/>
                <line x1="4" y1="12" x2="20" y2="12"/>
                <circle cx="9" cy="12" r="2.2" fill="currentColor"/>
                <line x1="4" y1="18" x2="20" y2="18"/>
                <circle cx="16" cy="18" r="2.2" fill="currentColor"/>
              </svg>
            </button>
          </div>
          {streaming ? (
            <button
              className="composer-stop-btn"
              type="button"
              onClick={() => onAbort?.()}
              aria-label="stop"
              title="Stop generating (abort run)"
              data-testid="composer-stop"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2"/>
              </svg>
            </button>
          ) : (
            <button
              className="composer-send-btn"
              type="submit"
              disabled={!value.trim() || busy || disabled}
              aria-label="send"
              data-testid="composer-send"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="19" x2="12" y2="5"/>
                <polyline points="5 12 12 5 19 12"/>
              </svg>
            </button>
          )}
        </div>
      </div>
    </form>
  )
}
