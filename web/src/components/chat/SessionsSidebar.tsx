import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import type { SessionInfo } from '../../lib/api'

interface Props {
  sessions: SessionInfo[]
  activeKey: string | null
  onPick: (sessionKey: string) => void
  onNewSession: () => void
  onRename: (sessionKey: string, title: string) => void
}

const TITLE_MAX_DISPLAY = 30

function shortId(sessionKey: string): string {
  // sess_<epochMs>_<rand6> → "<rand6>"
  const tail = sessionKey.split('_').pop() ?? sessionKey
  return tail.slice(0, 8)
}

function timeOf(createdAt: number): string {
  if (!createdAt) return ''
  const d = new Date(createdAt)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function truncate(s: string): string {
  if (s.length <= TITLE_MAX_DISPLAY) return s
  return s.slice(0, TITLE_MAX_DISPLAY - 1).trimEnd() + '…'
}

export function SessionsSidebar({
  sessions, activeKey, onPick, onNewSession, onRename,
}: Props): JSX.Element {
  const [renamingKey, setRenamingKey] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingKey && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [renamingKey])

  // Newest first.
  const sorted = [...sessions].sort((a, b) => b.createdAt - a.createdAt)

  const startRename = (s: SessionInfo) => {
    setRenamingKey(s.sessionKey)
    setDraft(s.title ?? '')
  }
  const cancelRename = () => { setRenamingKey(null); setDraft('') }
  const commitRename = () => {
    if (!renamingKey) return
    const next = draft.trim()
    onRename(renamingKey, next)
    cancelRename()
  }
  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commitRename() }
    else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
  }

  return (
    <div className="sessions-sidebar" data-testid="sessions-sidebar">
      <div className="sb-header">
        <h3>Sessions</h3>
        <button
          type="button"
          className="sb-new"
          onClick={onNewSession}
          data-testid="sb-new-session"
          aria-label="New session"
        >
          + New
        </button>
      </div>

      {sorted.length === 0 ? (
        <div className="sb-empty" data-testid="sb-empty">
          No sessions yet — start a chat to create one.
        </div>
      ) : (
        <ul className="sb-list">
          {sorted.map((s) => {
            const isActive = activeKey === s.sessionKey
            const titleText = s.title ?? shortId(s.sessionKey)
            const isRenaming = renamingKey === s.sessionKey
            return (
              <li
                key={s.sessionKey}
                className={`sb-row ${isActive ? 'sb-row-active' : ''}`}
                data-testid={`sb-row-${s.sessionKey}`}
                data-active={isActive ? 'true' : 'false'}
              >
                {isRenaming ? (
                  <input
                    ref={inputRef}
                    className="sb-rename-input"
                    data-testid="sb-rename-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onInputKey}
                    onBlur={cancelRename}
                  />
                ) : (
                  <button
                    type="button"
                    className="sb-row-main"
                    onClick={() => onPick(s.sessionKey)}
                  >
                    <div className="sb-row-title" data-testid="sb-row-title" title={titleText}>
                      {truncate(titleText)}
                    </div>
                    <div className="sb-row-sub">
                      {timeOf(s.createdAt)} · {shortId(s.sessionKey)}
                    </div>
                  </button>
                )}
                {!isRenaming ? (
                  <button
                    type="button"
                    className="sb-rename-btn"
                    onClick={(e) => { e.stopPropagation(); startRename(s) }}
                    data-testid={`sb-rename-${s.sessionKey}`}
                    aria-label="Rename session"
                    title="Rename session"
                  >
                    ✎
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
