import { useEffect, useMemo, useRef, useState } from 'react'

import { Icons } from '../icons/Icons'
import {
  loadWorkflows, saveWorkflows, newWorkflow, workflowToYaml,
  parseWorkflowYaml, stubAgent,
  type Workflow, type WorkflowStep,
} from '../../lib/workflows-store'
import { loadAgents, saveAgents, AGENT_KIND_META, type Agent } from '../../lib/agents-store'
import { createSkill, getKbGraph, getKbSkill, updateSkill } from '../../lib/api'
import { workflowSkillName, workflowSkillDescription, workflowToSkillMd } from '../../lib/workflow-to-skill'
import { useWorkflowRun } from '../../hooks/useWorkflowRun'
import { FlowCanvas } from './workflows/FlowCanvas'
import { WorkflowSidePanel } from './workflows/WorkflowSidePanel'

function iconFor(name: string) {
  const all = Icons as unknown as Record<string, (p: { size?: number }) => JSX.Element>
  return all[name] ?? all.swarm
}

/** True when every required workflow input has a non-empty value. Optional
 *  fields can be left blank — the agent prompt should describe sensible
 *  defaults. */
function areInputsValid(workflow: Workflow, draft: Record<string, string> | undefined): boolean {
  if (!workflow.inputs || workflow.inputs.length === 0) return true
  for (const f of workflow.inputs) {
    if (!f.required) continue
    const v = draft?.[f.name]
    if (!v || !v.trim()) return false
  }
  return true
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
  const [openStepId, setOpenStepId] = useState<string | null>(null)
  // Per-workflow input values, keyed by workflowId → fieldName → value. The
  // user fills this when the active workflow has declared `inputs`. The
  // values are submitted with run() so the first agent sees them.
  const [inputDrafts, setInputDrafts] = useState<Record<string, Record<string, string>>>({})
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

  const [savingSkill, setSavingSkill] = useState(false)
  const saveAsSkill = async () => {
    if (!active) return
    setSavingSkill(true)
    setReconcileMsg(null)
    try {
      const name = workflowSkillName(active)
      const description = workflowSkillDescription(active)
      const content = workflowToSkillMd(active, agents)
      // Try to detect whether the skill already exists; if so, update
      // (PUT) instead of POST. The GET returns 404 NOT_FOUND when missing.
      let exists = false
      try {
        await getKbSkill(name)
        exists = true
      } catch { /* 404 → create */ }
      if (exists) {
        await updateSkill(name, { content, frontmatter: { description } })
        setReconcileMsg(`updated skill "${name}" from "${active.name}"`)
      } else {
        await createSkill({ name, content, frontmatter: { description } })
        setReconcileMsg(`saved as skill "${name}" — ready for pi`)
      }
    } catch (err) {
      setReconcileMsg(`error saving skill: ${(err as Error).message}`)
    } finally { setSavingSkill(false) }
  }

  // Selected step lives independently from the open side panel — opening
  // the side panel selects, closing only deselects when the user explicitly
  // closes (so a re-render doesn't bounce the panel).
  const updateStep = (stepId: string, patch: Partial<WorkflowStep>) => {
    if (!active) return
    updateActive({
      steps: active.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)),
    })
  }
  const deleteStep = (stepId: string) => {
    if (!active) return
    const remaining = active.steps.filter((s) => s.id !== stepId)
    // Repoint any branches/next that targeted the removed step → 'end'.
    const cleaned = remaining.map((s) => {
      const ns: WorkflowStep = { ...s }
      if (ns.next === stepId) ns.next = 'end'
      if (ns.branches) {
        const nb: Record<string, string> = {}
        for (const [k, v] of Object.entries(ns.branches)) nb[k] = v === stepId ? 'end' : v
        ns.branches = nb
      }
      return ns
    })
    updateActive({ steps: cleaned })
    if (openStepId === stepId) setOpenStepId(null)
  }
  const openAgent = useMemo(() => {
    if (!active || !openStepId) return undefined
    const step = active.steps.find((s) => s.id === openStepId)
    if (!step) return undefined
    return agents.find((a) => a.id === step.agentId)
  }, [active, openStepId, agents])

  const runStatus = runState.status
  const statusClass =
    runStatus === 'running' || runStatus === 'queued' ? 'is-running'
    : runStatus === 'completed' ? 'is-completed'
    : runStatus === 'failed' ? 'is-failed'
    : ''

  return (
    <div className="page-root workflows-screen" data-testid="workflows" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <header className="wf-screen-header">
        <span className="wf-header-icon"><Icons.conductor size={18} /></span>
        <div className="wf-header-titles">
          <div className="wf-header-title">Workflow</div>
          <div className="wf-header-sub">
            Compose agents into a typed pipeline. Pin-to-pin contracts, draggable nodes, end-to-end I/O.
          </div>
        </div>
        <div className="wf-header-actions">
          <input ref={fileRef} type="file" accept=".yaml,.yml,application/yaml,text/yaml" style={{ display: 'none' }} onChange={onUploadFile} data-testid="workflows-upload-input" />
          <button className="wf-action-btn" onClick={() => fileRef.current?.click()} data-testid="workflows-upload">
            <Icons.tasks size={14} />Upload
          </button>
          <button className="wf-action-btn" disabled={!active} onClick={exportYaml} data-testid="workflows-export">
            <Icons.files size={14} />Export
          </button>
          <button
            className="wf-action-btn"
            disabled={!active || savingSkill || (active?.steps.length ?? 0) === 0}
            onClick={() => { void saveAsSkill() }}
            data-testid="workflows-save-as-skill"
            title="Persist this workflow as a SKILL.md so pi can invoke it."
          >{savingSkill ? 'saving…' : 'Save as Skill'}</button>
          <button className="wf-action-btn wf-action-primary" onClick={createNew} data-testid="workflows-new">
            + New workflow
          </button>
        </div>
      </header>

      {reconcileMsg ? (
        <div className="banner" data-testid="workflows-reconcile-msg" style={{ padding: '6px 20px', background: 'rgba(29,172,254,0.08)', fontSize: 12 }}>
          {reconcileMsg}
        </div>
      ) : null}

      <div className={`wf-stage-grid ${openStepId ? 'has-side-panel' : ''}`}>
        {/* LEFT — workflow list */}
        <aside className="wf-list-panel">
          <div className="wf-list-label">workflows · {workflows.length}</div>
          {workflows.length === 0 ? (
            <div className="dash-empty" style={{ padding: 12 }}>No workflows. Click "+ New workflow" or upload a .yaml.</div>
          ) : null}
          {workflows.map((w) => (
            <div
              key={w.id}
              className={`wf-list-row ${activeId === w.id ? 'is-active' : ''}`}
              onClick={() => { setActiveId(w.id); setOpenStepId(null) }}
              data-testid={`wf-list-${w.id}`}
            >
              <span className="wf-list-icon"><Icons.conductor size={13} /></span>
              <div className="wf-list-titles">
                <div className="wf-list-name">{w.name}</div>
                <div className="wf-list-meta">{w.steps.length} steps</div>
              </div>
              <button
                className="wf-list-delete"
                onClick={(e) => { e.stopPropagation(); removeWorkflow(w.id) }}
                data-testid={`wf-delete-${w.id}`}
                title="Delete workflow"
              >×</button>
            </div>
          ))}
        </aside>

        {/* CENTER — header + canvas (or YAML editor) */}
        {active ? (
          <div className="wf-canvas-wrap">
            <div className="wf-canvas-header">
              <input
                className="wf-canvas-title-input"
                value={active.name}
                onChange={(e) => updateActive({ name: e.target.value })}
                placeholder="Workflow name"
                data-testid="wf-name-input"
              />
              <textarea
                className="wf-canvas-task"
                rows={2}
                value={active.task}
                onChange={(e) => updateActive({ task: e.target.value })}
                placeholder="Describe the task this workflow accomplishes…"
                data-testid="wf-task-input"
              />
              <div className="wf-canvas-meta">
                <span className="wf-meta-pill">{active.steps.length} nodes</span>
                <span className="wf-meta-pill">{(active.bindings?.length ?? 0)} bindings</span>
                <span className={`wf-meta-pill ${statusClass}`} data-testid="wf-run-status">{runStatus}</span>
                {runState.runId ? <span className="wf-meta-pill" style={{ opacity: 0.6 }}>run {runState.runId.slice(0, 8)}</span> : null}
                <span className="wf-canvas-meta-spacer" />
                <button
                  className="wf-action-btn"
                  onClick={() => { setShowYaml((s) => !s); setYamlError(null) }}
                  data-testid="wf-toggle-yaml"
                >{showYaml ? 'Hide YAML' : 'Edit YAML'}</button>
                {runState.status === 'running' || runState.status === 'queued' ? (
                  <button
                    className="wf-action-btn"
                    onClick={() => { void cancel() }}
                    data-testid="wf-cancel"
                  >Cancel</button>
                ) : (
                  <button
                    className="wf-action-btn wf-action-primary"
                    disabled={starting || active.steps.length === 0 || !areInputsValid(active, inputDrafts[active.id])}
                    onClick={() => { void run(inputDrafts[active.id] ?? {}) }}
                    data-testid="wf-run"
                    title={!areInputsValid(active, inputDrafts[active.id]) ? 'Fill required workflow inputs first' : 'Run this workflow'}
                  >▸ Run</button>
                )}
              </div>

              {/* Workflow start prompt — shown when the workflow declares any
                  inputs. The user fills these before clicking Run. */}
              {(active.inputs?.length ?? 0) > 0 ? (
                <div className="wf-inputs-panel" data-testid="wf-inputs-panel">
                  <div className="wf-inputs-head">
                    <span className="wf-inputs-label">Start prompt — workflow inputs</span>
                    <span className="wf-inputs-hint">These values are passed to the first agent at run time. Required fields marked *.</span>
                  </div>
                  <div className="wf-inputs-grid">
                    {active.inputs!.map((f) => {
                      const v = inputDrafts[active.id]?.[f.name] ?? ''
                      const required = f.required === true
                      return (
                        <label className="wf-inputs-field" key={f.name} data-testid={`wf-input-${f.name}`}>
                          <span className="wf-inputs-name">
                            {f.name}{required ? <span className="wf-inputs-required">*</span> : null}
                            <span className="wf-inputs-type">{f.type}</span>
                          </span>
                          <input
                            className="wf-inputs-input"
                            type="text"
                            value={v}
                            placeholder={f.desc ?? `Enter ${f.name}…`}
                            onChange={(e) => {
                              const next = { ...(inputDrafts[active.id] ?? {}), [f.name]: e.target.value }
                              setInputDrafts((d) => ({ ...d, [active.id]: next }))
                            }}
                          />
                          {f.desc ? <span className="wf-inputs-desc">{f.desc}</span> : null}
                        </label>
                      )
                    })}
                  </div>
                </div>
              ) : null}

              {startError ? <div className="chat-msg-error" data-testid="wf-start-error" style={{ marginTop: 8 }}>{startError}</div> : null}
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
                  <button className="wf-action-btn wf-action-primary" onClick={() => { void applyYamlDraft() }} data-testid="wf-yaml-apply">Apply YAML</button>
                  <button
                    className="wf-action-btn"
                    onClick={() => { if (active) setYamlDraft(workflowToYaml(active, agents)) }}
                  >Reset</button>
                </div>
              </div>
            ) : (
              <div className="wf-canvas-flex">
                <FlowCanvas
                  workflow={active}
                  agents={agents}
                  runState={runState}
                  onWorkflowChange={(next) => updateActive({
                    steps: next.steps,
                    layout: next.layout,
                  })}
                  onOpenStep={(id) => setOpenStepId(id === openStepId ? null : id)}
                  selectedStepId={openStepId}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="dash-empty" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            No workflow selected
          </div>
        )}

        {/* RIGHT — side panel when open, palette otherwise */}
        {openStepId && active ? (
          <WorkflowSidePanel
            workflow={active}
            stepId={openStepId}
            agent={openAgent}
            cardState={runState.cards[openStepId]}
            onClose={() => setOpenStepId(null)}
            onUpdateStep={(patch) => updateStep(openStepId, patch)}
            onDeleteStep={() => deleteStep(openStepId)}
          />
        ) : (
          <aside className="wf-palette">
            <div className="wf-palette-head">
              <span className="wf-palette-label">Attach Agent</span>
              <button className="wf-palette-manage">⚙ Manage</button>
            </div>
            <div className="wf-palette-hint">
              Click a node on the canvas to inspect its contract. Or use the <strong>+</strong> handle on the last node to append a new step.
            </div>
            {agents.length === 0 ? (
              <div className="dash-empty" style={{ padding: 12, fontSize: 11 }}>No agents in roster. Add some on the Agents screen.</div>
            ) : null}
            {agents.map((a) => {
              const meta = AGENT_KIND_META[a.kind]
              const Icon = iconFor(meta.icon)
              const ins = a.inputs?.length ?? 0
              const outs = a.outputs?.length ?? 0
              return (
                <button
                  key={a.id}
                  className="wf-palette-row"
                  onClick={() => addStep(a.id)}
                  disabled={!active}
                  data-testid={`wf-palette-${a.id}`}
                  title={active ? `Append ${a.name}` : 'Select a workflow first'}
                  style={{ borderLeftColor: meta.color, background: meta.bg }}
                >
                  <span className="wf-palette-icon" style={{ background: 'rgba(0,0,0,0.25)', color: meta.color }}>
                    <Icon size={14} />
                  </span>
                  <div className="wf-palette-titles">
                    <div className="wf-palette-name">{a.name}</div>
                    <div className="wf-palette-meta">{ins} in · {outs} out · {a.kind}</div>
                  </div>
                  <span className="wf-palette-add">+</span>
                </button>
              )
            })}
          </aside>
        )}
      </div>
    </div>
  )
}
