import { useEffect, useRef } from 'react'

import { Composer } from '../chat/Composer'
import { Message } from '../chat/Message'
import { useChatStream } from '../../hooks/useChatStream'

interface Props { onSaveSkill?: (body: string) => void }

export function ChatScreen({ onSaveSkill }: Props = {}): JSX.Element {
  const chat = useChatStream()
  const scrollRef = useRef<HTMLDivElement>(null)

  // Autoscroll on new messages or text growth.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.messages.length, chat.messages[chat.messages.length - 1]?.text])

  return (
    <div className="chat-screen" data-testid="chat">
      <div className="chat-scroll" ref={scrollRef} data-testid="chat-scroll">
        <div className="chat-stack">
          {chat.messages.length === 0 ? (
            <div className="chat-empty" data-testid="chat-empty">
              <span className="kk-label-tiny">session</span>
              <h3>Ask the on-call agent anything.</h3>
              <p>Examples: <code>check disk on prod-vm-43</code> · <code>what's the COBRA onboarding flow?</code></p>
            </div>
          ) : (
            chat.messages.map((m) => <Message key={m.id} msg={m} onSaveSkill={onSaveSkill ? (msg) => onSaveSkill(msg.text) : undefined} />)
          )}
          {chat.error ? (
            <div className="chat-error-banner" data-testid="chat-error">
              {chat.error}
            </div>
          ) : null}
        </div>
      </div>
      <Composer onSend={chat.send} streaming={chat.streaming} disabled={!chat.sessionKey} />
    </div>
  )
}
