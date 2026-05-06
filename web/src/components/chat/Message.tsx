import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { ChatMessage } from '../../lib/streamingMessage'
import { ToolCard } from './ToolCard'

interface Props {
  msg: ChatMessage
  onSaveSkill?: (m: ChatMessage) => void
}

/** Anchor renderer: open external links in a new tab safely. */
// react-markdown v10 passes a `node` prop (hast node) we must NOT spread into the DOM.
function MdLink({ node: _node, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const href = props.href ?? ''
  const isExternal = /^https?:\/\//.test(href)
  return isExternal
    ? <a {...props} target="_blank" rel="noopener noreferrer" />
    : <a {...props} />
}

export function Message({ msg, onSaveSkill }: Props): JSX.Element {
  const renderText = () => {
    if (!msg.text) return null
    if (msg.role === 'assistant') {
      // Markdown for assistant only. react-markdown does NOT pass raw HTML
      // through by default — script tags etc. are stripped automatically.
      return (
        <div className="chat-msg-text chat-msg-text-md" data-testid={`chat-msg-${msg.id}-text`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MdLink }}>
            {msg.text}
          </ReactMarkdown>
        </div>
      )
    }
    // User / system: plain text. Preserve newlines via white-space: pre-wrap CSS.
    return (
      <div className="chat-msg-text" data-testid={`chat-msg-${msg.id}-text`}>
        {msg.text}
      </div>
    )
  }

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
      {renderText()}
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
