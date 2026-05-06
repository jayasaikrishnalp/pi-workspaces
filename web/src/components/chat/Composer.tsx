import { useState, type FormEvent, type KeyboardEvent } from 'react'

interface Props {
  onSend: (text: string) => void | Promise<void>
  disabled?: boolean
  streaming?: boolean
}

export function Composer({ onSend, disabled, streaming }: Props): JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!value.trim() || busy || disabled) return
    setBusy(true)
    const v = value
    setValue('')
    try { await onSend(v) } finally { setBusy(false) }
  }

  const onSubmit = (e: FormEvent) => { e.preventDefault(); void submit() }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() }
  }

  return (
    <form className="composer" onSubmit={onSubmit} data-testid="composer">
      <textarea
        className="composer-text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        placeholder={streaming ? 'streaming response…' : 'message the agent (⌘+Enter to send)'}
        rows={2}
        disabled={disabled}
        data-testid="composer-text"
      />
      <button
        className="btn btn-primary composer-send"
        type="submit"
        disabled={!value.trim() || busy || disabled}
        data-testid="composer-send"
      >
        {streaming ? 'sending…' : 'send'}
      </button>
    </form>
  )
}
