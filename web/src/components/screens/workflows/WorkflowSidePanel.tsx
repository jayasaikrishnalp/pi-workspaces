/**
 * WorkflowSidePanel — full detail for a step opened on the canvas.
 *
 * Three tabs, Railway-deploy-view-style:
 *   Details — agent role, prompt, typed I/O, per-step note (the original
 *             editing surface).
 *   Logs    — live structured event stream (timestamp + tag + text) from
 *             the SSE pipeline. Filterable.
 *   Output  — the agent's final markdown output for this step.
 *
 * Default tab is `Logs` when there's run data, `Details` otherwise.
 */
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Icons } from '../../icons/Icons'
import { AGENT_KIND_META, type Agent } from '../../../lib/agents-store'
import type { Workflow, WorkflowStep } from '../../../lib/workflows-store'
import type { CardState, LogEntry } from '../../../hooks/useWorkflowRun'

interface Props {
  workflow: Workflow
  stepId: string
  agent: Agent | undefined
  cardState: CardState | undefined
  onClose: () => void
  onUpdateStep: (patch: Partial<WorkflowStep>) => void
  onDeleteStep: () => void
}

type Tab = 'details' | 'logs' | 'output'

function iconFor(name: string) {
  const all = Icons as unknown as Record<string, (p: { size?: number }) => JSX.Element>
  return all[name] ?? all.swarm
}

function fmtTs(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const TAG_LABEL: Record<LogEntry['tag'], string> = {
  run: 'RUN', step: 'STEP', out: 'OUT', tool: 'TOOL', end: 'END', err: 'ERR',
}

export function WorkflowSidePanel({
  workflow, stepId, agent, cardState, onClose, onUpdateStep, onDeleteStep,
}: Props): JSX.Element | null {
  const step = workflow.steps.find((s) => s.id === stepId)
  // hooks must run on every render — declare before any early return
  const [draftNote, setDraftNote] = useState(step?.note ?? '')
  const hasRunData = !!(cardState && (cardState.logs?.length || cardState.output || cardState.error))
  const [tab, setTab] = useState<Tab>(hasRunData ? 'logs' : 'details')
  const [filter, setFilter] = useState('')

  useEffect(() => { setDraftNote(step?.note ?? '') }, [step?.id, step?.note])

  // When the user re-clicks a node mid-run, prefer Logs over Details so they
  // can see the live stream without an extra click.
  useEffect(() => {
    if (hasRunData && tab === 'details') setTab('logs')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId])

  const filteredLogs = useMemo(() => {
    const logs = cardState?.logs ?? []
    if (!filter.trim()) return logs
    const q = filter.toLowerCase()
    return logs.filter((l) => l.text.toLowerCase().includes(q) || l.tag.includes(q))
  }, [cardState?.logs, filter])

  if (!step) return null
  const meta = agent ? AGENT_KIND_META[agent.kind] : null
  const Icon = agent && meta ? iconFor(meta.icon) : Icons.conductor

  const commitNote = () => {
    if (draftNote === (step.note ?? '')) return
    onUpdateStep({ note: draftNote })
  }

  const status = cardState?.status ?? 'idle'

  return (
    <aside className="fc-sidepanel" data-testid={`fc-sidepanel-${step.id}`}>
      <div className="fc-sidepanel-head">
        <span
          className="fc-sidepanel-icon"
          style={meta ? { background: meta.bg, color: meta.color } : undefined}
        >
          <Icon size={14} />
        </span>
        <div className="fc-sidepanel-titles">
          <div className="fc-sidepanel-title">{agent?.name ?? `(missing: ${step.agentId})`}</div>
          <div className="fc-sidepanel-sub">
            {agent ? `${agent.kind} · ${agent.model}` : 'unknown agent'} · step <code>{step.id}</code>
            <span className={`fc-sidepanel-status fc-sidepanel-status-${status}`}>{status}</span>
          </div>
        </div>
        <button className="fc-sidepanel-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      {/* Tab strip — Railway-style underline tabs */}
      <div className="fc-sidepanel-tabs" role="tablist">
        <button
          role="tab"
          className={`fc-sidepanel-tab ${tab === 'details' ? 'is-active' : ''}`}
          onClick={() => setTab('details')}
        >Details</button>
        <button
          role="tab"
          className={`fc-sidepanel-tab ${tab === 'logs' ? 'is-active' : ''}`}
          onClick={() => setTab('logs')}
        >
          Logs
          {(cardState?.logs?.length ?? 0) > 0 ? (
            <span className="fc-sidepanel-tab-count">{cardState!.logs!.length}</span>
          ) : null}
        </button>
        <button
          role="tab"
          className={`fc-sidepanel-tab ${tab === 'output' ? 'is-active' : ''}`}
          onClick={() => setTab('output')}
        >Output</button>
        {tab === 'logs' ? (
          <input
            type="text"
            className="fc-sidepanel-filter"
            placeholder='Filter logs ("error", "snow", …)'
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="fc-sidepanel-filter"
          />
        ) : null}
      </div>

      <div className="fc-sidepanel-body">
        {tab === 'details' ? (
          <>
            {/* Per-step instructions */}
            <section>
              <div className="fc-sidepanel-section-title">Step instructions</div>
              <textarea
                className="fc-sidepanel-textarea"
                rows={4}
                placeholder="What should this step do for THIS workflow? (per-step note, prepended to the agent prompt at runtime)"
                value={draftNote}
                onChange={(e) => setDraftNote(e.target.value)}
                onBlur={commitNote}
                data-testid={`fc-sidepanel-note-${step.id}`}
              />
            </section>

            {/* Agent role + prompt (read-only) */}
            {agent ? (
              <section>
                <div className="fc-sidepanel-section-title">Agent role</div>
                <div className="fc-sidepanel-role">{agent.role}</div>
                <div className="fc-sidepanel-section-title" style={{ marginTop: 12 }}>Agent prompt</div>
                <pre className="fc-sidepanel-prompt">{agent.prompt}</pre>
                <div className="fc-sidepanel-hint">Edit the prompt itself on the Agents screen.</div>
              </section>
            ) : (
              <section>
                <div className="fc-sidepanel-warn">Agent <code>{step.agentId}</code> is missing from the roster.</div>
              </section>
            )}

            {/* I/O schema */}
            {(agent?.inputs?.length ?? 0) > 0 || (agent?.outputs?.length ?? 0) > 0 ? (
              <section>
                <div className="fc-sidepanel-section-title">Typed I/O</div>
                {agent!.inputs && agent!.inputs.length > 0 ? (
                  <div className="fc-sidepanel-fields">
                    <div className="fc-sidepanel-fields-label">Inputs</div>
                    {agent!.inputs.map((f) => (
                      <div key={f.name} className="fc-sidepanel-field">
                        <span className="fc-sidepanel-field-name">{f.name}{f.required ? ' *' : ''}</span>
                        <span className="fc-sidepanel-field-type">{f.type}</span>
                        {f.desc ? <div className="fc-sidepanel-field-desc">{f.desc}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
                {agent!.outputs && agent!.outputs.length > 0 ? (
                  <div className="fc-sidepanel-fields">
                    <div className="fc-sidepanel-fields-label">Outputs</div>
                    {agent!.outputs.map((f) => (
                      <div key={f.name} className="fc-sidepanel-field">
                        <span className="fc-sidepanel-field-name">{f.name}</span>
                        <span className="fc-sidepanel-field-type">{f.type}</span>
                        {f.desc ? <div className="fc-sidepanel-field-desc">{f.desc}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}
          </>
        ) : tab === 'logs' ? (
          <section className="fc-sidepanel-logs">
            {filteredLogs.length === 0 ? (
              <div className="fc-sidepanel-logs-empty">
                {cardState?.logs?.length
                  ? `No log lines match "${filter}".`
                  : 'No log entries yet — run the workflow to see live output here.'}
              </div>
            ) : (
              <div className="fc-sidepanel-logtable" role="table">
                <div className="fc-sidepanel-logtable-head" role="row">
                  <span className="fc-sidepanel-logtable-th-date">Date</span>
                  <span className="fc-sidepanel-logtable-th-msg">Message</span>
                </div>
                {filteredLogs.map((entry, i) => (
                  <div
                    key={i}
                    className={`fc-sidepanel-logrow fc-sidepanel-logrow-${entry.tag}`}
                    role="row"
                  >
                    <span className="fc-sidepanel-logrow-date">{fmtTs(entry.ts)}</span>
                    <span className={`fc-sidepanel-logrow-tag fc-sidepanel-logrow-tag-${entry.tag}`}>
                      {TAG_LABEL[entry.tag]}
                    </span>
                    <span className="fc-sidepanel-logrow-text">{entry.text}</span>
                  </div>
                ))}
              </div>
            )}
            {cardState?.error ? (
              <div className="fc-sidepanel-error" style={{ marginTop: 12 }}>{cardState.error}</div>
            ) : null}
            {cardState?.decision ? (
              <div className="fc-sidepanel-decision" style={{ marginTop: 8 }}>decision: {cardState.decision}</div>
            ) : null}
          </section>
        ) : (
          <section>
            {cardState?.output ? (
              <div className="fc-sidepanel-output-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {cardState.output}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="fc-sidepanel-logs-empty">
                No output yet — the step hasn't produced a final response.
              </div>
            )}
            {cardState?.error ? (
              <div className="fc-sidepanel-error" style={{ marginTop: 12 }}>{cardState.error}</div>
            ) : null}
          </section>
        )}
      </div>

      <div className="fc-sidepanel-foot">
        <span className="fc-sidepanel-foot-meta">
          status: <strong>{status}</strong>
          {cardState?.next ? <> · next: <code>{cardState.next}</code></> : null}
        </span>
        <button
          className="fc-sidepanel-delete"
          onClick={() => {
            if (window.confirm(`Remove "${agent?.name ?? step.agentId}" from this workflow?`)) onDeleteStep()
          }}
          data-testid={`fc-sidepanel-delete-${step.id}`}
        >Remove step</button>
      </div>
    </aside>
  )
}
