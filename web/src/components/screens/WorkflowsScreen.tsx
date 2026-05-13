import { useEffect, useMemo, useRef, useState } from 'react'

import { Icons } from '../icons/Icons'
import {
  loadWorkflows, saveWorkflows, newWorkflow, workflowToYaml,
  parseWorkflowYaml, stubAgent,
  type Workflow, type WorkflowStep,
} from '../../lib/workflows-store'
import { loadAgents, saveAgents, AGENT_KIND_META, type Agent } from '../../lib/agents-store'
import { createSkill, getKbGraph, getKbSkill, updateSkill, listWorkflowRuns, type WorkflowRun } from '../../lib/api'
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
  return missingRequiredInputs(workflow, draft).length === 0
}

/** Names of required inputs that are still empty. Used to gate Run + tell
 *  the user exactly what to fill in. */
function missingRequiredInputs(workflow: Workflow, draft: Record<string, string> | undefined): string[] {
  if (!workflow.inputs || workflow.inputs.length === 0) return []
  const missing: string[] = []
  for (const f of workflow.inputs) {
    if (!f.required) continue
    const v = draft?.[f.name]
    if (!v || !v.trim()) missing.push(f.name)
  }
  return missing
}

/** Human-readable "Xs/m/h/d ago". Shared with KnowledgeBaseScreen pattern. */
function formatAgo(ts: number | null | undefined): string {
  if (!ts) return ''
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

interface Props {
  /** Notifies the parent (App.tsx) when a run is in flight so it can lock chat. */
  onRunStateChange?: (info: { running: boolean; workflowName: string | null; activeStepId: string | null }) => void
}

export function WorkflowsScreen({ onRunStateChange }: Props = {}): JSX.Element {
  const [workflows, setWorkflows] = useState<Workflow[]>(loadWorkflows)
  // viewMode: 'list' shows the card grid; 'editor' shows the canvas modal.
  // Default to 'list' so /workflows lands on a chooser, not the editor.
  const [viewMode, setViewMode] = useState<'list' | 'editor'>('list')
  const [activeId, setActiveId] = useState<string | null>(null)
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
  // Bumped by the Refresh button (and on editor close) so each WorkflowCard
  // re-fetches its latest run status.
  const [refreshTick, setRefreshTick] = useState(0)
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

  // Esc closes the editor modal and returns to the list view.
  useEffect(() => {
    if (viewMode !== 'editor') return
    // Apply the user's saved side-panel width to the modal's CSS var so the
    // panel opens at the size the user last left it.
    try {
      const saved = localStorage.getItem('hive.workflows.sidepanelWidth')
      if (saved && /^\d+px$/.test(saved.trim())) {
        const modal = document.querySelector('.wf-editor-modal') as HTMLElement | null
        if (modal) modal.style.setProperty('--side-panel-width', saved)
      }
    } catch { /* ignore */ }
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeEditor()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // closeEditor is stable enough for this scope; rebuild on viewMode change is sufficient
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode])

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

  const openEditor = (id: string) => {
    setActiveId(id)
    setOpenStepId(null)
    setShowYaml(false)
    setViewMode('editor')
  }
  const closeEditor = () => {
    setOpenStepId(null)
    setViewMode('list')
    // Re-fetch card statuses so any run started in the editor shows on cards.
    setRefreshTick((t) => t + 1)
  }

  const createNew = () => {
    const wf = newWorkflow()
    setWorkflows((prev) => [wf, ...prev])
    setActiveId(wf.id)
    setOpenStepId(null)
    setShowYaml(false)
    setViewMode('editor')
  }

  const removeWorkflow = (id: string) => {
    if (!window.confirm('Delete this workflow? This cannot be undone.')) return
    setWorkflows((prev) => prev.filter((w) => w.id !== id))
    if (activeId === id) {
      setActiveId(null)
      setViewMode('list')
    }
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
      // Open the imported workflow directly in the editor.
      setActiveId(parsed.workflow.id)
      setViewMode('editor')

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

  const inEditor = viewMode === 'editor' && active != null

  return (
    <div className="page-root workflows-screen" data-testid="workflows" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <header className="wf-screen-header">
        <span className="wf-header-icon"><Icons.conductor size={18} /></span>
        <div className="wf-header-titles">
          <div className="wf-header-title">Workflows</div>
          <div className="wf-header-sub">
            {viewMode === 'list'
              ? `${workflows.length} workflow${workflows.length === 1 ? '' : 's'} · click a card to edit, or start a new one`
              : 'Compose agents into a typed pipeline. Pin-to-pin contracts, draggable nodes, end-to-end I/O.'}
          </div>
        </div>
        <div className="wf-header-actions">
          <input ref={fileRef} type="file" accept=".yaml,.yml,application/yaml,text/yaml" style={{ display: 'none' }} onChange={onUploadFile} data-testid="workflows-upload-input" />
          {viewMode === 'list' ? (
            <button
              className="wf-action-btn"
              onClick={() => setRefreshTick((t) => t + 1)}
              data-testid="workflows-refresh"
              title="Re-fetch latest run status for every workflow"
            ><Icons.tasks size={14} />Refresh</button>
          ) : null}
          <button className="wf-action-btn" onClick={() => fileRef.current?.click()} data-testid="workflows-upload">
            <Icons.tasks size={14} />Upload
          </button>
          {viewMode === 'editor' ? (
            <>
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
            </>
          ) : null}
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

      {/* === LIST VIEW === */}
      {viewMode === 'list' ? (
        <div className="wf-list-grid" data-testid="wf-list-grid">
          {workflows.length === 0 ? (
            <div className="wf-list-empty">
              No workflows yet. Click <strong>+ New workflow</strong> or <strong>Upload</strong> a .yaml.
            </div>
          ) : (
            workflows.map((w) => (
              <WorkflowCard
                key={w.id}
                workflow={w}
                refreshTick={refreshTick}
                onOpen={() => openEditor(w.id)}
                onDelete={() => removeWorkflow(w.id)}
              />
            ))
          )}
        </div>
      ) : null}

      {/* === EDITOR MODAL === */}
      {inEditor ? (
        <>
          <div
            className="wf-editor-shade"
            onClick={closeEditor}
            data-testid="wf-editor-shade"
          />
          <div
            className={`wf-editor-modal ${openStepId ? 'has-side-panel' : ''}`}
            role="dialog"
            aria-modal="true"
            data-testid="wf-editor-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="wf-editor-close"
              onClick={closeEditor}
              data-testid="wf-editor-close"
              title="Close editor (Esc)"
              aria-label="Close editor"
            >×</button>

            {/* CENTER — header + canvas (or YAML editor) */}
            <div className="wf-canvas-wrap">
              <div className="wf-canvas-header">
                <label className="wf-field">
                  <span className="wf-field-label">Workflow name</span>
                  <input
                    className="wf-canvas-title-input"
                    value={active.name}
                    onChange={(e) => updateActive({ name: e.target.value })}
                    placeholder="Untitled workflow — click to rename"
                    data-testid="wf-name-input"
                  />
                </label>
                <label className="wf-field">
                  <span className="wf-field-label">What this workflow does</span>
                  <textarea
                    className="wf-canvas-task"
                    rows={2}
                    value={active.task}
                    onChange={(e) => updateActive({ task: e.target.value })}
                    placeholder="Describe the task this workflow accomplishes…"
                    data-testid="wf-task-input"
                  />
                </label>
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
                  <button
                    className="wf-action-btn"
                    onClick={() => {
                      saveWorkflows(workflows)
                      setReconcileMsg(`saved "${active.name}"`)
                      window.setTimeout(() => setReconcileMsg((m) => m === `saved "${active.name}"` ? null : m), 2000)
                    }}
                    data-testid="wf-save"
                    title="Persist this workflow to local storage now (auto-save also runs on every edit)"
                  >Save</button>
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

                {/* Inputs are edited inline on the START canvas node below.
                    No separate panel — keeps the screen compact. */}

                {/* Always-visible hint when Run is gated by missing inputs. */}
                {(() => {
                  const missing = missingRequiredInputs(active, inputDrafts[active.id])
                  if (missing.length === 0) return null
                  return (
                    <div
                      className="wf-run-hint"
                      data-testid="wf-run-hint"
                      style={{ marginTop: 6, fontSize: 11, color: 'rgba(240, 197, 118, 0.9)' }}
                    >
                      Fill required input{missing.length > 1 ? 's' : ''}{' '}
                      {missing.map((name, i) => (
                        <span key={name}>
                          {i > 0 ? ', ' : ''}
                          <code style={{ background: 'rgba(255,255,255,0.06)', padding: '1px 5px', borderRadius: 3 }}>{name}</code>
                        </span>
                      ))}
                      {' '}on the Workflow Input node to enable Run.
                    </div>
                  )
                })()}

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
                    inputValues={inputDrafts[active.id] ?? {}}
                    onInputChange={(name, value) => {
                      const next = { ...(inputDrafts[active.id] ?? {}), [name]: value }
                      setInputDrafts((d) => ({ ...d, [active.id]: next }))
                    }}
                    onAddInput={() => {
                      // Append a new input. Pick a free-form text textarea by
                      // default (matches the L1 free-form lookup pattern).
                      // Auto-name to avoid collisions: prompt, prompt_2, …
                      const existing = active.inputs ?? []
                      const taken = new Set(existing.map((i) => i.name))
                      let name = 'prompt'
                      let n = 2
                      while (taken.has(name)) { name = `prompt_${n++}` }
                      updateActive({
                        inputs: [
                          ...existing,
                          { name, type: 'text', required: true, desc: 'Free-form prompt — describe what the workflow should do' },
                        ],
                      })
                    }}
                  />
                </div>
              )}
            </div>

            {/* RIGHT — side panel when open, palette otherwise */}
            {openStepId ? (
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
        </>
      ) : null}
    </div>
  )
}

/* ===== Workflow card (list view) ===== */

interface WorkflowCardProps {
  workflow: Workflow
  refreshTick: number
  onOpen: () => void
  onDelete: () => void
}

function WorkflowCard({ workflow, refreshTick, onOpen, onDelete }: WorkflowCardProps): JSX.Element {
  const [latestRun, setLatestRun] = useState<WorkflowRun | null>(null)
  const [loading, setLoading] = useState(false)

  // Fetch the latest run on mount, on workflow id change, and on each
  // refresh tick. The list endpoint already returns runs sorted by start
  // time descending, so runs[0] is the most recent.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listWorkflowRuns(workflow.id)
      .then((res) => {
        if (cancelled) return
        setLatestRun(res.runs[0] ?? null)
      })
      .catch(() => { /* offline / no auth — show "no runs yet" */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [workflow.id, refreshTick])

  const status = latestRun?.status ?? 'idle'
  const taskPreview = (workflow.task ?? '').trim()
  const stepWord = workflow.steps.length === 1 ? 'step' : 'steps'
  const bindingCount = workflow.bindings?.length ?? 0
  const inputCount = workflow.inputs?.length ?? 0

  return (
    <div
      className="wf-card"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      data-testid={`wf-card-${workflow.id}`}
    >
      <span className="wf-card-icon"><Icons.conductor size={14} /></span>
      <div className="wf-card-body">
        <div className="wf-card-head">
          <div className="wf-card-name">{workflow.name}</div>
          <span className={`wf-card-status wf-card-status-${status}`}>{status}</span>
        </div>
        {taskPreview ? <div className="wf-card-task">{taskPreview}</div> : null}
        <div className="wf-card-meta">
          {workflow.steps.length} {stepWord} · {bindingCount} binding{bindingCount === 1 ? '' : 's'}{inputCount > 0 ? ` · ${inputCount} input${inputCount === 1 ? '' : 's'}` : ''}
        </div>
        <div className="wf-card-runrow">
          {loading ? (
            <span className="wf-card-runrow-empty">checking last run…</span>
          ) : latestRun ? (
            <>Last run: <strong>{latestRun.status}</strong>{latestRun.started_at ? <> · {formatAgo(latestRun.started_at)}</> : null}</>
          ) : (
            <span className="wf-card-runrow-empty">no runs yet</span>
          )}
        </div>
      </div>
      <button
        className="wf-card-delete"
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        title="Delete workflow"
        aria-label="Delete workflow"
        data-testid={`wf-card-delete-${workflow.id}`}
      >×</button>
    </div>
  )
}
