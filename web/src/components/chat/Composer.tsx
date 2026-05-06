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
}

export function Composer({
  onSend,
  disabled,
  streaming,
  seed,
  seedNonce,
  onSwitchModel,
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
    if (!value.trim() || busy || disabled) return
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
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
            <button
              type="button"
              className="composer-icon-btn"
              title="Attach (coming soon)"
              aria-label="Attach"
              disabled
              data-testid="composer-attach"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12.4 12.6 20.8a5.5 5.5 0 0 1-7.8-7.8L13.2 4.6a3.7 3.7 0 0 1 5.2 5.2L9.9 18.3a1.8 1.8 0 0 1-2.6-2.6l7.4-7.4"/>
              </svg>
            </button>
            <button
              type="button"
              className="composer-icon-btn"
              title="Switch model (⌘.)"
              aria-label="Switch model"
              onClick={() => onSwitchModel?.()}
              data-testid="composer-switch-model"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <line x1="4" y1="6" x2="20" y2="6"/>
                <circle cx="14" cy="6" r="2.2" fill="currentColor"/>
                <line x1="4" y1="12" x2="20" y2="12"/>
                <circle cx="9" cy="12" r="2.2" fill="currentColor"/>
                <line x1="4" y1="18" x2="20" y2="18"/>
                <circle cx="16" cy="18" r="2.2" fill="currentColor"/>
              </svg>
            </button>
          </div>
          <button
            className="composer-send-btn"
            type="submit"
            disabled={!value.trim() || busy || disabled}
            aria-label={streaming ? 'sending' : 'send'}
            data-testid="composer-send"
          >
            {streaming ? (
              <span className="composer-send-dots">···</span>
            ) : (
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="19" x2="12" y2="5"/>
                <polyline points="5 12 12 5 19 12"/>
              </svg>
            )}
          </button>
        </div>
      </div>
    </form>
  )
}
