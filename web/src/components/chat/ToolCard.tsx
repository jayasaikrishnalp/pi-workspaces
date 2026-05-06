import { useState } from 'react'

import type { ToolCall } from '../../lib/streamingMessage'

export function ToolCard({ call }: { call: ToolCall }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`tool-card status-${call.status}`} data-testid={`tool-card-${call.id}`}>
      <button className="tool-card-head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool-card-status status-${call.status}`}>{call.status}</span>
        <span className="tool-card-name">{call.name}</span>
        {call.durationMs != null ? <span className="tool-card-meta">{(call.durationMs / 1000).toFixed(1)}s</span> : null}
        <span className="tool-card-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="tool-card-body">
          {call.args !== undefined ? (
            <div className="tool-card-section">
              <div className="kk-label-tiny">ARGS</div>
              <pre className="tool-card-pre">{format(call.args)}</pre>
            </div>
          ) : null}
          {call.result !== undefined ? (
            <div className="tool-card-section">
              <div className="kk-label-tiny">RESULT</div>
              <pre className="tool-card-pre" data-testid={`tool-card-${call.id}-result`}>{format(call.result)}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function format(v: unknown): string {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}
