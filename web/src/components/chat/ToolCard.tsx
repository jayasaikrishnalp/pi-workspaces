import { useEffect, useRef, useState } from 'react'

import type { ToolCall } from '../../lib/streamingMessage'

/** Map status → pill text + className suffix. Hermes-style phase badges. */
function phaseFor(call: ToolCall): { label: string; cls: string } {
  switch (call.status) {
    case 'pending':   return { label: 'preparing',  cls: 'pending' }
    case 'running':   return { label: 'running',    cls: 'running' }
    case 'completed': return { label: 'completed',  cls: 'completed' }
    case 'errored':   return { label: 'failed',     cls: 'errored' }
    default:          return { label: call.status,  cls: call.status }
  }
}

export function ToolCard({ call }: { call: ToolCall }): JSX.Element {
  // Default expanded once a result lands so the user sees output without
  // clicking. After that, follow user toggles. Track whether user has
  // explicitly toggled so we don't override their preference.
  const [open, setOpen] = useState(false)
  const userToggled = useRef(false)

  useEffect(() => {
    if (userToggled.current) return
    if (call.status === 'completed' || call.status === 'errored') {
      setOpen(true)
    }
  }, [call.status])

  const phase = phaseFor(call)
  const hasArgs = call.args !== undefined && call.args !== null && call.args !== ''
  const hasResult = call.result !== undefined && call.result !== null
  const argsPreview = hasArgs ? oneLine(format(call.args)) : null

  return (
    <div
      className={`tool-card status-${call.status}`}
      data-testid={`tool-card-${call.id}`}
      data-status={call.status}
    >
      <button
        type="button"
        className="tool-card-head"
        onClick={() => { userToggled.current = true; setOpen((v) => !v) }}
        aria-expanded={open}
      >
        <span className={`tool-card-status status-${phase.cls}`}>{phase.label}</span>
        <span className="tool-card-name">{call.name}</span>
        {argsPreview ? (
          <span className="tool-card-preview" data-testid={`tool-card-${call.id}-preview`}>
            {argsPreview}
          </span>
        ) : null}
        {call.durationMs != null ? (
          <span className="tool-card-meta">{(call.durationMs / 1000).toFixed(1)}s</span>
        ) : null}
        <span className="tool-card-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="tool-card-body">
          {hasArgs ? (
            <div className="tool-card-section">
              <div className="kk-label-tiny">INPUT</div>
              <pre className="tool-card-pre" data-testid={`tool-card-${call.id}-args`}>{format(call.args)}</pre>
            </div>
          ) : null}
          {hasResult ? (
            <div className="tool-card-section">
              <div className="kk-label-tiny">OUTPUT</div>
              <pre className="tool-card-pre" data-testid={`tool-card-${call.id}-result`}>{format(call.result)}</pre>
            </div>
          ) : null}
          {call.error ? (
            <div className="tool-card-section">
              <div className="kk-label-tiny">ERROR</div>
              <pre className="tool-card-pre tool-card-pre-err" data-testid={`tool-card-${call.id}-error`}>{call.error}</pre>
            </div>
          ) : null}
          {!hasArgs && !hasResult && !call.error ? (
            <div className="tool-card-empty">no input or output yet · {phase.label}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function format(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

/** Compact a value to a single line for collapsed previews. Cap length too. */
function oneLine(s: string): string {
  const compact = s.replace(/\s+/g, ' ').trim()
  return compact.length > 60 ? compact.slice(0, 57) + '…' : compact
}
