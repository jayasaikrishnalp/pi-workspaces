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

/**
 * Decide what activity label to show under a streaming assistant message.
 * Phases (priority order):
 *   - "Calling <name>…" if any tool is in pending or running state
 *   - "Streaming response…" if any text has arrived
 *   - "Thinking…" otherwise (also covers thinking-only events)
 */
function activityLabel(msg: ChatMessage): string {
  const liveTool = msg.toolCalls.find((t) => t.status === 'running' || t.status === 'pending')
  if (liveTool) return `Calling ${liveTool.name}…`
  if (msg.text && msg.text.length > 0) return 'Streaming response…'
  return 'Thinking…'
}

/**
 * Heuristic: is this assistant message worth keeping as a reusable skill?
 * Yes when the reply has structure (a fenced code block, numbered steps, a
 * bullet list, or substantial length). Plain conversational replies don't
 * pollute the surface with a save button.
 */
function isSkillCandidate(text: string): boolean {
  if (!text) return false
  const t = text.trim()
  if (t.length < 30) return false                                  // hard floor: no one-liners
  if (/```[\s\S]+?```/.test(t)) return true                        // fenced code block → always
  // ≥3 numbered steps "1. ... 2. ... 3. ..."
  if (/(?:^|\n)\s*1\.\s+/.test(t) && /(?:^|\n)\s*2\.\s+/.test(t) && /(?:^|\n)\s*3\.\s+/.test(t)) return true
  // ≥3 bullet items with "- " or "* "
  const bullets = (t.match(/(?:^|\n)\s*[-*]\s+/g) ?? []).length
  if (bullets >= 3) return true
  // Otherwise require a fairly long, structured reply.
  if (t.length >= 500) return true
  return false
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

  const showSaveSkill =
    msg.role === 'assistant' &&
    !msg.streaming &&
    !!onSaveSkill &&
    isSkillCandidate(msg.text)

  return (
    <div className={`chat-msg role-${msg.role}`} data-testid={`chat-msg-${msg.id}`} data-role={msg.role}>
      <div className="chat-msg-head">
        <span className="chat-msg-role">{msg.role}</span>
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
          {msg.toolCalls.map((c) => (
            <ToolCard key={c.id} call={c} messageStreaming={msg.streaming} />
          ))}
        </div>
      ) : null}
      {renderText()}
      {msg.streaming ? (
        <div className="chat-msg-activity" data-testid={`chat-msg-${msg.id}-activity`}>
          <span className="chat-msg-activity-spinner" aria-hidden="true" />
          <span className="chat-msg-activity-label">{activityLabel(msg)}</span>
        </div>
      ) : null}
      {msg.error ? (
        <div className="chat-msg-error" data-testid={`chat-msg-${msg.id}-error`}>{msg.error}</div>
      ) : null}
      {showSaveSkill ? (
        <div className="chat-msg-actions">
          <button
            className="btn btn-accent"
            onClick={() => onSaveSkill?.(msg)}
            data-testid={`chat-msg-${msg.id}-save-skill`}
          >
            save as skill
          </button>
        </div>
      ) : null}
    </div>
  )
}
