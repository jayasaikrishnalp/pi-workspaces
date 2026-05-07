/**
 * WorkflowSidePanel — full detail for a step opened on the canvas.
 *
 * Shows: agent identity, model, role; per-step note (editable); the agent's
 * full prompt (read-only — agents are edited on the Agents screen); typed
 * input/output schema; and live run output.
 */
import { useEffect, useState } from 'react'

import { Icons } from '../../icons/Icons'
import { AGENT_KIND_META, type Agent } from '../../../lib/agents-store'
import type { Workflow, WorkflowStep } from '../../../lib/workflows-store'
import type { CardState } from '../../../hooks/useWorkflowRun'

interface Props {
  workflow: Workflow
  stepId: string
  agent: Agent | undefined
  cardState: CardState | undefined
  onClose: () => void
  onUpdateStep: (patch: Partial<WorkflowStep>) => void
  onDeleteStep: () => void
}

function iconFor(name: string) {
  const all = Icons as unknown as Record<string, (p: { size?: number }) => JSX.Element>
  return all[name] ?? all.swarm
}

export function WorkflowSidePanel({
  workflow, stepId, agent, cardState, onClose, onUpdateStep, onDeleteStep,
}: Props): JSX.Element | null {
  const step = workflow.steps.find((s) => s.id === stepId)
  if (!step) return null
  const meta = agent ? AGENT_KIND_META[agent.kind] : null
  const Icon = agent && meta ? iconFor(meta.icon) : Icons.conductor

  const [draftNote, setDraftNote] = useState(step.note ?? '')
  useEffect(() => { setDraftNote(step.note ?? '') }, [step.id, step.note])

  const commitNote = () => {
    if (draftNote === (step.note ?? '')) return
    onUpdateStep({ note: draftNote })
  }

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
          </div>
        </div>
        <button className="fc-sidepanel-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="fc-sidepanel-body">
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

        {/* Live run output */}
        {cardState && (cardState.output || cardState.error || cardState.decision) ? (
          <section>
            <div className="fc-sidepanel-section-title">Run output</div>
            {cardState.error ? (
              <div className="fc-sidepanel-error">{cardState.error}</div>
            ) : null}
            {cardState.decision ? (
              <div className="fc-sidepanel-decision">decision: {cardState.decision}</div>
            ) : null}
            {cardState.output ? (
              <pre className="fc-sidepanel-output">{cardState.output}</pre>
            ) : null}
          </section>
        ) : null}
      </div>

      <div className="fc-sidepanel-foot">
        <span className="fc-sidepanel-foot-meta">
          status: <strong>{cardState?.status ?? 'idle'}</strong>
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
