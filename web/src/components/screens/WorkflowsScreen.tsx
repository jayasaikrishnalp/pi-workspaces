import { useEffect, useMemo, useRef, useState } from 'react'

import { Icons } from '../icons/Icons'
import {
  loadWorkflows, saveWorkflows, newWorkflow, workflowToYaml,
  parseWorkflowYaml, stubAgent,
  type Workflow, type WorkflowStep,
} from '../../lib/workflows-store'
import { loadAgents, saveAgents, AGENT_KIND_META, type Agent } from '../../lib/agents-store'
import { createSkill, getKbGraph } from '../../lib/api'

function iconFor(name: string) {
  const all = Icons as unknown as Record<string, (p: { size?: number }) => JSX.Element>
  return all[name] ?? all.swarm
}

export function WorkflowsScreen(): JSX.Element {
  const [workflows, setWorkflows] = useState<Workflow[]>(loadWorkflows)
  const [activeId, setActiveId] = useState<string | null>(workflows[0]?.id ?? null)
  const [agents, setAgents] = useState<Agent[]>(loadAgents)
  const [showYaml, setShowYaml] = useState(false)
  const [yamlDraft, setYamlDraft] = useState('')
  const [yamlError, setYamlError] = useState<string | null>(null)
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null)
  const [knownSkills, setKnownSkills] = useState<Set<string>>(new Set())
  const fileRef = useRef<HTMLInputElement>(null)

  // Persist on every change.
  useEffect(() => { saveWorkflows(workflows) }, [workflows])
  useEffect(() => { saveAgents(agents) }, [agents])

  // Pull current skill catalog so we can detect missing skills on YAML upload.
  useEffect(() => {
    getKbGraph()
      .then((g) => setKnownSkills(new Set(g.nodes.filter((n) => n.source === 'skill').map((n) => n.id))))
      .catch(() => { /* offline: missing-skills detection best-effort */ })
  }, [])

  const active = workflows.find((w) => w.id === activeId) ?? null

  // Refresh YAML preview when active workflow / agents change while panel open.
  useEffect(() => {
    if (showYaml && active) setYamlDraft(workflowToYaml(active, agents))
  }, [showYaml, active, agents])

  const updateActive = (patch: Partial<Workflow>) => {
    setWorkflows((prev) => prev.map((w) => (w.id === activeId ? { ...w, ...patch } : w)))
  }

  const addStep = (agentId: string) => {
    if (!active) return
    const step: WorkflowStep = {
      id: `step-${active.steps.length + 1}`,
      agentId,
      note: '',
    }
    updateActive({ steps: [...active.steps, step] })
  }

  const removeStep = (idx: number) => {
    if (!active) return
    updateActive({ steps: active.steps.filter((_, i) => i !== idx) })
  }

  const moveStep = (idx: number, dir: -1 | 1) => {
    if (!active) return
    const swap = idx + dir
    if (swap < 0 || swap >= active.steps.length) return
    const next = active.steps.slice()
    const a = next[idx]!
    const b = next[swap]!
    next[idx] = b
    next[swap] = a
    updateActive({ steps: next })
  }

  const updateStep = (idx: number, patch: Partial<WorkflowStep>) => {
    if (!active) return
    const next = active.steps.slice()
    next[idx] = { ...next[idx]!, ...patch }
    updateActive({ steps: next })
  }

  const createNew = () => {
    const wf = newWorkflow()
    setWorkflows((prev) => [wf, ...prev])
    setActiveId(wf.id)
  }

  const removeWorkflow = (id: string) => {
    if (!window.confirm('Delete this workflow? This cannot be undone.')) return
    setWorkflows((prev) => {
      const next = prev.filter((w) => w.id !== id)
      if (activeId === id) setActiveId(next[0]?.id ?? null)
      return next
    })
  }

  const exportYaml = () => {
    if (!active) return
    const yaml = workflowToYaml(active, agents)
    const blob = new Blob([yaml], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${active.name.replace(/\s+/g, '-').toLowerCase()}.workflow.yaml`
    a.click()
    URL.revokeObjectURL(url)
  }

  const onUploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = String(ev.target?.result ?? '')
      void importYaml(text, file.name)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const applyYamlDraft = async () => {
    setYamlError(null)
    await importYaml(yamlDraft, 'inline-edit')
  }

  const importYaml = async (yamlText: string, source: string) => {
    setYamlError(null)
    setReconcileMsg(null)
    try {
      const parsed = parseWorkflowYaml(yamlText, agents, knownSkills)
      // Reconcile agents.
      const newAgents: Agent[] = []
      const existingIds = new Set(agents.map((a) => a.id))
      for (const a of parsed.inlinedAgents) {
        if (!existingIds.has(a.id)) newAgents.push(a)
      }
      for (const id of parsed.missingAgentIds) {
        if (!existingIds.has(id) && !newAgents.find((a) => a.id === id)) {
          newAgents.push(stubAgent(id))
        }
      }
      if (newAgents.length > 0) setAgents((prev) => [...prev, ...newAgents])

      // Reconcile skills (best-effort, async — don't block import).
      const skillFailures: string[] = []
      for (const skill of parsed.missingSkills) {
        try {
          await createSkill({
            name: skill,
            content:
              `# ${skill}\n\nAuto-generated stub. Edit on the Skills screen.\n\n` +
              `## Trigger\n\nWhen the agent decides to call \`${skill}\`.\n\n## Steps\n\n1. (fill in)\n`,
            frontmatter: { description: `Stub skill auto-created by workflow upload (${source}).` },
          })
        } catch (err) {
          skillFailures.push(`${skill}: ${(err as Error).message}`)
        }
      }

      // Replace or insert workflow.
      setWorkflows((prev) => {
        const idx = prev.findIndex((w) => w.id === parsed.workflow.id)
        if (idx === -1) return [parsed.workflow, ...prev]
        const next = prev.slice()
        next[idx] = parsed.workflow
        return next
      })
      setActiveId(parsed.workflow.id)

      const msgs = [`imported "${parsed.workflow.name}" from ${source}`]
      if (newAgents.length > 0) msgs.push(`+${newAgents.length} agent${newAgents.length > 1 ? 's' : ''}`)
      const skillsCreated = parsed.missingSkills.length - skillFailures.length
      if (skillsCreated > 0) msgs.push(`+${skillsCreated} skill stub${skillsCreated > 1 ? 's' : ''}`)
      if (skillFailures.length > 0) msgs.push(`(${skillFailures.length} skill failures)`)
      setReconcileMsg(msgs.join(' · '))
      setShowYaml(false)
    } catch (err) {
      setYamlError((err as Error).message)
    }
  }

  return (
    <div className="page-root workflows-screen" data-testid="workflows" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div className="page-header" style={{ display: 'flex', gap: 8, padding: '12px 16px', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
        <Icons.conductor size={18} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600 }}>Workflow</div>
          <div className="kb-meta" style={{ fontSize: 11 }}>YAML-defined pipelines · upload to import &amp; auto-scaffold missing agents/skills</div>
        </div>
        <input ref={fileRef} type="file" accept=".yaml,.yml,application/yaml,text/yaml" style={{ display: 'none' }} onChange={onUploadFile} data-testid="workflows-upload-input" />
        <button className="btn btn-ghost small" onClick={() => fileRef.current?.click()} data-testid="workflows-upload">Upload .yaml</button>
        <button className="btn btn-ghost small" disabled={!active} onClick={exportYaml} data-testid="workflows-export">Export .yaml</button>
        <button className="btn btn-accent small" onClick={createNew} data-testid="workflows-new">+ New workflow</button>
      </div>

      {reconcileMsg ? (
        <div className="banner" data-testid="workflows-reconcile-msg" style={{ padding: '6px 16px', background: 'rgba(29,172,254,0.08)', fontSize: 12 }}>
          {reconcileMsg}
        </div>
      ) : null}

      <div className="wf-stage" style={{ display: 'grid', gridTemplateColumns: '240px 1fr 260px', gap: 0, flex: 1, minHeight: 0 }}>
        {/* LEFT — workflow list */}
        <aside className="wf-list" style={{ borderRight: '1px solid var(--border)', overflow: 'auto', padding: 8 }}>
          <div className="kk-label-tiny" style={{ padding: '4px 6px' }}>workflows · {workflows.length}</div>
          {workflows.length === 0 ? (
            <div className="dash-empty" style={{ padding: 12 }}>No workflows. Click "+ New workflow" or upload a .yaml.</div>
          ) : null}
          {workflows.map((w) => (
            <div
              key={w.id}
              className={`wf-list-row ${activeId === w.id ? 'active' : ''}`}
              onClick={() => setActiveId(w.id)}
              data-testid={`wf-list-${w.id}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 8px',
                borderRadius: 4, cursor: 'pointer',
                background: activeId === w.id ? 'rgba(29,172,254,0.08)' : 'transparent',
              }}
            >
              <Icons.conductor size={14} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.name}</div>
                <div className="mono" style={{ fontSize: 10, opacity: 0.5 }}>{w.steps.length} steps</div>
              </div>
              <button
                className="btn btn-ghost small"
                onClick={(e) => { e.stopPropagation(); removeWorkflow(w.id) }}
                data-testid={`wf-delete-${w.id}`}
                title="Delete workflow"
              >×</button>
            </div>
          ))}
        </aside>

        {/* CENTER — composer */}
        {active ? (
          <div className="wf-composer" style={{ overflow: 'auto', padding: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
              <input
                className="input mono"
                value={active.name}
                onChange={(e) => updateActive({ name: e.target.value })}
                placeholder="Workflow name"
                data-testid="wf-name-input"
                style={{ fontSize: 16, fontWeight: 600 }}
              />
              <div style={{ display: 'flex', gap: 8, fontSize: 11, opacity: 0.6 }}>
                <span className="kk-label-tiny">id</span>
                <span className="mono">{active.id}</span>
                <span>·</span>
                <span className="mono">{active.steps.length} steps</span>
              </div>
              <textarea
                className="input mono"
                rows={3}
                value={active.task}
                onChange={(e) => updateActive({ task: e.target.value })}
                placeholder="Describe the task this workflow accomplishes…"
                data-testid="wf-task-input"
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0' }}>
              <span className="kk-label-tiny" style={{ flex: 1 }}>pipeline (flow)</span>
              <button
                className="btn btn-ghost small"
                onClick={() => { setShowYaml((s) => !s); setYamlError(null) }}
                data-testid="wf-toggle-yaml"
              >{showYaml ? 'Hide' : 'Edit'} YAML</button>
            </div>

            <PipelineList
              workflow={active}
              agents={agents}
              onRemove={removeStep}
              onUp={(i) => moveStep(i, -1)}
              onDown={(i) => moveStep(i, +1)}
              onUpdate={updateStep}
            />

            {showYaml ? (
              <div style={{ marginTop: 16 }}>
                <textarea
                  className="input mono"
                  rows={20}
                  value={yamlDraft}
                  onChange={(e) => setYamlDraft(e.target.value)}
                  data-testid="wf-yaml-textarea"
                  style={{ fontSize: 12, lineHeight: 1.5, width: '100%' }}
                />
                {yamlError ? <div className="chat-msg-error" data-testid="wf-yaml-error">{yamlError}</div> : null}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-accent small" onClick={() => { void applyYamlDraft() }} data-testid="wf-yaml-apply">Apply YAML</button>
                  <button
                    className="btn btn-ghost small"
                    onClick={() => { if (active) setYamlDraft(workflowToYaml(active, agents)) }}
                  >Reset</button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="dash-empty" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            No workflow selected
          </div>
        )}

        {/* RIGHT — agent palette */}
        <aside style={{ borderLeft: '1px solid var(--border)', overflow: 'auto', padding: 8 }}>
          <div className="kk-label-tiny" style={{ padding: '4px 6px' }}>attach agent</div>
          {agents.length === 0 ? (
            <div className="dash-empty" style={{ padding: 12, fontSize: 11 }}>No agents in roster. Add some on the Agents screen.</div>
          ) : null}
          {agents.map((a) => {
            const meta = AGENT_KIND_META[a.kind]
            const Icon = iconFor(meta.icon)
            return (
              <button
                key={a.id}
                className="btn btn-ghost"
                onClick={() => addStep(a.id)}
                disabled={!active}
                data-testid={`wf-palette-${a.id}`}
                title={active ? `Append ${a.name}` : 'Select a workflow first'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 8,
                  marginBottom: 4, background: meta.bg, borderLeft: `2px solid ${meta.color}`,
                  textAlign: 'left',
                }}
              >
                <Icon size={14} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mono" style={{ fontSize: 12 }}>{a.name}</div>
                  <div className="mono" style={{ fontSize: 10, opacity: 0.5 }}>{a.kind} · {a.skills.length} skills</div>
                </div>
                +
              </button>
            )
          })}
        </aside>
      </div>
    </div>
  )
}

interface PipelineProps {
  workflow: Workflow
  agents: Agent[]
  onRemove: (idx: number) => void
  onUp: (idx: number) => void
  onDown: (idx: number) => void
  onUpdate: (idx: number, patch: Partial<WorkflowStep>) => void
}

function PipelineList({ workflow, agents, onRemove, onUp, onDown, onUpdate }: PipelineProps): JSX.Element {
  const stepIds = useMemo(() => workflow.steps.map((s) => s.id), [workflow.steps])
  const nextOptions: Array<{ value: string; label: string }> = useMemo(() => {
    return [
      { value: '', label: '(default: next step)' },
      { value: 'end', label: 'end (terminate)' },
      ...stepIds.map((id) => ({ value: id, label: id })),
    ]
  }, [stepIds])

  if (workflow.steps.length === 0) {
    return (
      <div className="dash-empty" data-testid="wf-pipeline-empty">
        Click an agent on the right to add it to the pipeline.
      </div>
    )
  }
  return (
    <div className="wf-pipeline" data-testid="wf-pipeline">
      {workflow.steps.map((s, idx) => {
        const a = agents.find((x) => x.id === s.agentId)
        const meta = a ? AGENT_KIND_META[a.kind] : null
        const Icon = a && meta ? iconFor(meta.icon) : Icons.conductor
        return (
          <div key={`${s.id}-${idx}`} data-testid={`wf-step-${idx}`}>
            <div
              className="wf-step"
              style={{
                display: 'grid', gridTemplateColumns: '32px 32px 1fr auto', gap: 8,
                padding: 10, borderRadius: 6,
                border: '1px solid var(--border)',
                background: meta?.bg ?? 'var(--bg-elev)',
                borderLeft: `3px solid ${meta?.color ?? 'var(--border)'}`,
              }}
            >
              <div className="mono" style={{ fontSize: 11, opacity: 0.6, alignSelf: 'center', textAlign: 'center' }}>{String(idx + 1).padStart(2, '0')}</div>
              <div style={{ alignSelf: 'center', textAlign: 'center' }}><Icon size={14} /></div>
              <div style={{ minWidth: 0 }}>
                {a ? (
                  <>
                    <div className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{a.name}</div>
                    <div className="mono" style={{ fontSize: 10, opacity: 0.6 }}>{a.kind} · {a.model}</div>
                  </>
                ) : (
                  <div className="mono" style={{ fontSize: 12, color: 'var(--err, #f87171)' }}>missing agent: {s.agentId}</div>
                )}
                <input
                  className="input mono"
                  style={{ marginTop: 6, width: '100%', fontSize: 11 }}
                  value={s.note}
                  onChange={(e) => onUpdate(idx, { note: e.target.value })}
                  placeholder="Step instruction (optional)…"
                  data-testid={`wf-step-note-${idx}`}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="kk-label-tiny">id</span>
                  <input
                    className="input mono"
                    style={{ fontSize: 11, width: 120 }}
                    value={s.id}
                    onChange={(e) => onUpdate(idx, { id: e.target.value })}
                  />
                  <span className="kk-label-tiny">next</span>
                  <select
                    className="input mono"
                    style={{ fontSize: 11 }}
                    value={s.next ?? ''}
                    onChange={(e) => onUpdate(idx, { next: e.target.value || undefined })}
                  >
                    {nextOptions.filter((o) => o.value !== s.id).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <BranchEditor
                  step={s}
                  options={nextOptions.filter((o) => o.value !== s.id)}
                  onChange={(branches) => onUpdate(idx, { branches })}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <button className="btn btn-ghost small" disabled={idx === 0} onClick={() => onUp(idx)} title="Move up">↑</button>
                <button className="btn btn-ghost small" disabled={idx === workflow.steps.length - 1} onClick={() => onDown(idx)} title="Move down">↓</button>
                <button className="btn btn-ghost small" onClick={() => onRemove(idx)} title="Delete step" data-testid={`wf-step-remove-${idx}`}>×</button>
              </div>
            </div>
            {idx < workflow.steps.length - 1 ? (
              <div style={{ textAlign: 'center', padding: '4px 0', opacity: 0.4, fontSize: 12 }}>↓</div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function BranchEditor({
  step, options, onChange,
}: {
  step: WorkflowStep
  options: Array<{ value: string; label: string }>
  onChange: (branches: Record<string, string> | undefined) => void
}): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [decision, setDecision] = useState('')
  const [target, setTarget] = useState('end')
  const branches = step.branches ?? {}
  const entries = Object.entries(branches)

  const apply = (next: Record<string, string>) => {
    onChange(Object.keys(next).length > 0 ? next : undefined)
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div className="kk-label-tiny" style={{ marginBottom: 4 }}>branches (optional)</div>
      {entries.length === 0 ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {entries.map(([key, val]) => (
            <div key={key} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
              <span className="mono" style={{ flex: '0 0 110px' }}>"{key}"</span>
              <span style={{ opacity: 0.5 }}>→</span>
              <select
                className="input mono"
                style={{ fontSize: 11, flex: 1 }}
                value={val}
                onChange={(e) => apply({ ...branches, [key]: e.target.value })}
              >
                {options.map((o) => <option key={o.value || 'default'} value={o.value || ''}>{o.label}</option>)}
              </select>
              <button
                className="btn btn-ghost small"
                onClick={() => {
                  const { [key]: _drop, ...rest } = branches
                  void _drop
                  apply(rest)
                }}
                title="Remove branch"
              >×</button>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          <input
            className="input mono"
            style={{ flex: '0 0 110px', fontSize: 11 }}
            placeholder="decision"
            value={decision}
            onChange={(e) => setDecision(e.target.value)}
          />
          <span style={{ opacity: 0.5 }}>→</span>
          <select className="input mono" style={{ fontSize: 11, flex: 1 }} value={target} onChange={(e) => setTarget(e.target.value)}>
            {options.map((o) => <option key={o.value || 'default'} value={o.value || ''}>{o.label}</option>)}
          </select>
          <button
            className="btn btn-ghost small"
            disabled={!decision.trim()}
            onClick={() => {
              apply({ ...branches, [decision.trim()]: target })
              setDecision(''); setTarget('end'); setAdding(false)
            }}
          >add</button>
          <button className="btn btn-ghost small" onClick={() => setAdding(false)}>×</button>
        </div>
      ) : (
        <button className="btn btn-ghost small" onClick={() => setAdding(true)} style={{ fontSize: 11, marginTop: 4 }}>+ branch</button>
      )}
    </div>
  )
}
