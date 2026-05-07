import { useCallback, useEffect, useRef, useState } from 'react'

import { Composer } from '../chat/Composer'
import { Message } from '../chat/Message'
import { SessionsSidebar } from '../chat/SessionsSidebar'
import { useChatStream } from '../../hooks/useChatStream'
import { listSessions, setSessionTitle, type SessionInfo } from '../../lib/api'

interface Props {
  onSaveSkill?: (body: string) => void
  /** When set, the composer is disabled with a banner. The string explains why. */
  lockedReason?: string | null
}

interface QuickAction {
  id: string
  label: string
  icon: JSX.Element
  prompt: string
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'aws',
    label: 'Investigate AWS alarm',
    icon: (
      // simple cloud
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 18h11a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.5 9.2 4.5 4.5 0 0 0 7 18z"/>
      </svg>
    ),
    prompt:
      'Investigate the most recent AWS CloudWatch alarm. Pull metric, affected resource, recent deploys, and recommend next checks.',
  },
  {
    id: 'jira',
    label: 'Triage Jira ticket',
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="16" rx="2"/>
        <path d="M9 12h6M12 9v6"/>
      </svg>
    ),
    prompt:
      'Pick up the highest-priority Jira ticket assigned to me, summarize the ask, and propose a 3-step plan to close it.',
  },
  {
    id: 'confluence',
    label: 'Lookup Confluence runbook',
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 3h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>
        <path d="M14 3v6h6"/>
        <path d="M8 13h8M8 17h6"/>
      </svg>
    ),
    prompt:
      'Find the Confluence runbook for the on-call escalation flow. Quote the first three steps verbatim and link the page.',
  },
  {
    id: 'snow',
    label: 'Open ServiceNow incident',
    icon: (
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9"/>
        <path d="M12 7v6"/>
        <circle cx="12" cy="16.5" r="1" fill="currentColor"/>
      </svg>
    ),
    prompt:
      'Show open ServiceNow incidents in my queue, sorted by SLA breach risk. Recommend which to tackle first and why.',
  },
]

export function ChatScreen({ onSaveSkill, lockedReason }: Props = {}): JSX.Element {
  const chat = useChatStream()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [seed, setSeed] = useState<string | undefined>(undefined)
  const [seedNonce, setSeedNonce] = useState(0)

  // Sidebar collapse state. Persist across reloads. Default open.
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem('hive.chatSidebar') !== 'closed'
  })
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem('hive.chatSidebar', sidebarOpen ? 'open' : 'closed')
  }, [sidebarOpen])
  // Ctrl+B / Cmd+B toggles sidebar (Hermes pattern).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        setSidebarOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Sessions list — refresh on mount, after sends complete, and after rename.
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const refreshSessions = useCallback(async () => {
    try {
      const r = await listSessions()
      setSessions(r.sessions)
    } catch (err) {
      console.error('[ChatScreen] listSessions failed:', err)
    }
  }, [])
  useEffect(() => { void refreshSessions() }, [refreshSessions])
  // Refresh after each send terminates so a new auto-title shows up.
  useEffect(() => {
    if (!chat.streaming && chat.sessionKey) void refreshSessions()
  }, [chat.streaming, chat.sessionKey, refreshSessions])

  const handleRename = useCallback(async (key: string, title: string) => {
    try {
      await setSessionTitle(key, title)
      await refreshSessions()
    } catch (err) {
      console.error('[ChatScreen] rename failed:', err)
    }
  }, [refreshSessions])

  // Autoscroll on new messages or text growth.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.messages.length, chat.messages[chat.messages.length - 1]?.text])

  const seedComposer = (text: string) => {
    setSeed(text)
    setSeedNonce((n) => n + 1)
  }

  return (
    <div className={`chat-screen ${sidebarOpen ? 'with-sidebar' : 'no-sidebar'}`} data-testid="chat">
      {sidebarOpen ? (
        <SessionsSidebar
          sessions={sessions}
          activeKey={chat.sessionKey}
          onPick={chat.switchSession}
          onNewSession={() => { void chat.newSession() }}
          onRename={(key, title) => { void handleRename(key, title) }}
        />
      ) : null}
      <button
        type="button"
        className="sb-toggle"
        title={sidebarOpen ? 'Hide sessions (⌘B)' : 'Show sessions (⌘B)'}
        aria-label="Toggle sessions sidebar"
        onClick={() => setSidebarOpen((v) => !v)}
        data-testid="sb-toggle"
      >
        {sidebarOpen ? '◀' : '▶'}
      </button>
      <div className="chat-pane">
      <div className="chat-scroll" ref={scrollRef} data-testid="chat-scroll">
        <div className="chat-stack">
          {chat.messages.length === 0 ? (
            <div className="chat-empty chat-hero" data-testid="chat-empty">
              <img
                className="chat-hero-avatar"
                src="/hive-avatar.svg"
                alt="Hive mascot"
                width="120"
                height="120"
              />
              <span className="chat-hero-overline">HIVE WORKSPACE</span>
              <h1 className="chat-hero-title">Begin a session</h1>
              <p className="chat-hero-model">default · claude-opus-4-6</p>
              <p className="chat-hero-tagline">Agent chat · live tools · memory · full observability</p>
              <div className="chat-hero-chips">
                {QUICK_ACTIONS.map((qa) => (
                  <button
                    key={qa.id}
                    type="button"
                    className="chip-action"
                    onClick={() => seedComposer(qa.prompt)}
                    data-testid={`chat-chip-${qa.id}`}
                  >
                    <span className="chip-action-icon" aria-hidden="true">{qa.icon}</span>
                    <span>{qa.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            chat.messages.map((m) => (
              <Message
                key={m.id}
                msg={m}
                onSaveSkill={onSaveSkill ? (msg) => onSaveSkill(msg.text) : undefined}
              />
            ))
          )}
          {chat.error ? (
            <div className="chat-error-banner" data-testid="chat-error">
              {chat.error}
            </div>
          ) : null}
        </div>
      </div>
      {lockedReason ? (
        <div
          className="banner banner-warn"
          data-testid="chat-locked-banner"
          style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid var(--border)', background: 'rgba(255,203,82,0.10)' }}
        >
          🔒 {lockedReason}
        </div>
      ) : null}
      <Composer
        onSend={chat.send}
        streaming={chat.streaming}
        disabled={!chat.sessionKey || !!lockedReason}
        seed={seed}
        seedNonce={seedNonce}
        onAbort={chat.abort}
      />
      </div>
    </div>
  )
}
