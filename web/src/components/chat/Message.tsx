import type { ChatMessage } from '../../lib/streamingMessage'
import { ToolCard } from './ToolCard'

interface Props {
  msg: ChatMessage
  onSaveSkill?: (m: ChatMessage) => void
}

export function Message({ msg, onSaveSkill }: Props): JSX.Element {
  return (
    <div className={`chat-msg role-${msg.role}`} data-testid={`chat-msg-${msg.id}`} data-role={msg.role}>
      <div className="chat-msg-head">
        <span className="chat-msg-role">{msg.role}</span>
        {msg.streaming ? <span className="chat-msg-streaming" data-testid={`chat-msg-${msg.id}-streaming`}>streaming…</span> : null}
        {msg.usage ? <span className="chat-msg-usage">{msg.usage}</span> : null}
      </div>
      {msg.thinking ? (
        <div className="chat-msg-thinking" data-testid={`chat-msg-${msg.id}-thinking`}>
          <span className="kk-label-tiny">thinking</span>
          <pre>{msg.thinking}</pre>
        </div>
      ) : null}
      {msg.toolCalls.length > 0 ? (
        <div className="chat-msg-tools">
          {msg.toolCalls.map((c) => <ToolCard key={c.id} call={c} />)}
        </div>
      ) : null}
      {msg.text ? (
        <div className="chat-msg-text" data-testid={`chat-msg-${msg.id}-text`}>{msg.text}</div>
      ) : null}
      {msg.error ? (
        <div className="chat-msg-error" data-testid={`chat-msg-${msg.id}-error`}>{msg.error}</div>
      ) : null}
      {msg.role === 'assistant' && !msg.streaming && msg.text && onSaveSkill ? (
        <div className="chat-msg-actions">
          <button className="btn btn-accent" onClick={() => onSaveSkill(msg)} data-testid={`chat-msg-${msg.id}-save-skill`}>
            save as skill
          </button>
        </div>
      ) : null}
    </div>
  )
}
