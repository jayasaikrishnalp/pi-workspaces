import { useEffect, useRef, useState } from 'react'

import { Icons } from '../icons/Icons'
import {
  loadWorkflows, saveWorkflows, newWorkflow, workflowToYaml,
  parseWorkflowYaml, stubAgent,
  type Workflow, type WorkflowStep,
} from '../../lib/workflows-store'
import { loadAgents, saveAgents, AGENT_KIND_META, type Agent } from '../../lib/agents-store'
import { createSkill, getKbGraph } from '../../lib/api'
import { useWorkflowRun } from '../../hooks/useWorkflowRun'
import { WorkflowCanvas } from './workflows/WorkflowCanvas'

function iconFor(name: string) {
  const all = Icons as unknown as Record<string, (p: { size?: number }) => JSX.Element>
  return all[name] ?? all.swarm
}

interface Props {
  /** Notifies the parent (App.tsx) when a run is in flight so it can lock chat. */
  onRunStateChange?: (info: { running: boolean; workflowName: string | null; activeStepId: string | null }) => void
}

export function WorkflowsScreen({ onRunStateChange }: Props = {}): JSX.Element {
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

  // Live run state for the active workflow.
  const { state: runState, run, cancel, starting, startError } = useWorkflowRun(active, agents)

  // Surface run state to parent so it can lock the chat composer.
  useEffect(() => {
    onRunStateChange?.({
      running: runState.status === 'running' || runState.status === 'queued',
      workflowName: active?.name ?? null,
      activeStepId: runState.activeStepId,
    })
  }, [runState.status, runState.activeStepId, active?.name, onRunStateChange])

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

        {/* CENTER — header + canvas (or YAML editor) */}
        {active ? (
          <div className="wf-composer" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, padding: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <input
                className="input mono"
                value={active.name}
                onChange={(e) => updateActive({ name: e.target.value })}
                placeholder="Workflow name"
                data-testid="wf-name-input"
                style={{ fontSize: 16, fontWeight: 600 }}
              />
              <div style={{ display: 'flex', gap: 8, fontSize: 11, opacity: 0.6, alignItems: 'center' }}>
                <span className="kk-label-tiny">id</span>
                <span className="mono">{active.id}</span>
                <span>·</span>
                <span className="mono">{active.steps.length} steps</span>
                <span>·</span>
                <span className="mono" data-testid="wf-run-status">{runState.status}</span>
                {runState.runId ? <span className="mono" style={{ opacity: 0.5 }}>run {runState.runId.slice(0, 8)}</span> : null}
                <span style={{ flex: 1 }} />
                {runState.status === 'running' || runState.status === 'queued' ? (
                  <button
                    className="btn btn-ghost small"
                    onClick={() => { void cancel() }}
                    data-testid="wf-cancel"
                  >Cancel</button>
                ) : (
                  <button
                    className="btn btn-accent small"
                    disabled={starting || active.steps.length === 0}
                    onClick={() => { void run() }}
                    data-testid="wf-run"
                  >▸ Run</button>
                )}
                <button
                  className="btn btn-ghost small"
                  onClick={() => { setShowYaml((s) => !s); setYamlError(null) }}
                  data-testid="wf-toggle-yaml"
                >{showYaml ? 'Hide' : 'Edit'} YAML</button>
              </div>
              <textarea
                className="input mono"
                rows={2}
                value={active.task}
                onChange={(e) => updateActive({ task: e.target.value })}
                placeholder="Describe the task this workflow accomplishes…"
                data-testid="wf-task-input"
              />
              {startError ? <div className="chat-msg-error" data-testid="wf-start-error">{startError}</div> : null}
            </div>

            {showYaml ? (
              <div style={{ padding: 16, overflow: 'auto', flex: 1 }}>
                <textarea
                  className="input mono"
                  rows={24}
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
            ) : (
              <div style={{ flex: 1, minHeight: 0 }}>
                <WorkflowCanvas
                  workflow={active}
                  agents={agents}
                  runState={runState}
                  onCancel={cancel}
                />
              </div>
            )}
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
