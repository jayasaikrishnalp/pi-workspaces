import { useEffect, useMemo, useState } from 'react'

import { useApi } from '../../../hooks/useApi'
import { useWorkflowRun } from '../../../hooks/useWorkflowRun'
import {
  listWorkflows, getWorkflow,
  type WorkflowSummary, type WorkflowStep, type WorkflowStepStatus,
} from '../../../lib/api'

type RailTab = 'output' | 'steps' | 'spec' | 'runs'

export function WorkflowConductor(): JSX.Element {
  const list = useApi('workflows.list', listWorkflows)
  const workflows = list.data?.workflows ?? []
  const [activeName, setActiveName] = useState<string | null>(null)

  // Pick the first workflow by default once loaded.
  useEffect(() => {
    if (!activeName && workflows.length > 0) setActiveName(workflows[0]!.name)
  }, [workflows, activeName])

  const active = workflows.find((w) => w.name === activeName) ?? null
  const steps: WorkflowStep[] = active?.steps ?? []
  const [heroIndex, setHeroIndex] = useState(0)
  // Reset hero when active workflow changes.
  useEffect(() => { setHeroIndex(0) }, [activeName])

  const { state: runState, run, cancel, starting, startError } = useWorkflowRun(active?.name ?? null)

  const upstream = heroIndex > 0 ? [steps[heroIndex - 1]!] : []
  const downstream = heroIndex < steps.length - 1 ? [steps[heroIndex + 1]!] : []
  const heroStep = steps[heroIndex] ?? null

  return (
    <div className="wfc-root" data-testid="workflow-conductor">
      <ConductorHeader
        workflows={workflows}
        active={activeName}
        onPick={setActiveName}
        running={runState.status === 'running' || runState.status === 'queued'}
      />
      {!active ? (
        <div className="wfc-empty">
          <div>No workflow selected.</div>
          <div className="hint">Pick one from the dropdown above, or POST /api/workflows to create one.</div>
        </div>
      ) : steps.length === 0 ? (
        <div className="wfc-empty">
          <div>{active.name} has no steps yet.</div>
          <div className="hint">Add steps via PUT /api/workflows/{active.name} (full editor coming in Phase C).</div>
        </div>
      ) : (
        <div className="wfc-stage">
          <div className="wfc-canvas" data-testid="wfc-canvas">
            <div className="wfc-bg" />
            <div className="wfc-bg-vignette" />

            <div className="wfc-canvas-chrome">
              <button className="wfc-chip" onClick={() => list.reload()}>↻ Sync</button>
              <button className="wfc-chip wfc-chip-primary" disabled title="Phase C: add step in canvas">+ Step</button>
            </div>

            <div className="wfc-stage-scroll">
              <div className="wfc-column">
                {upstream.length > 0 && (
                  <>
                    <div className="wfc-row">
                      {upstream.map((s, i) => (
                        <MiniNode
                          key={`up-${i}`}
                          step={s}
                          edgeLabel={`step ${heroIndex} →`}
                          status={getStepStatus(runState.steps, heroIndex - 1)}
                          onClick={() => setHeroIndex(heroIndex - 1)}
                        />
                      ))}
                    </div>
                    <Connectors count={1} active={getStepStatus(runState.steps, heroIndex) === 'running'} />
                  </>
                )}

                {heroStep && (
                  <HeroCard
                    step={heroStep}
                    index={heroIndex}
                    total={steps.length}
                    status={getStepStatus(runState.steps, heroIndex)}
                    output={runState.steps[heroIndex]?.output ?? ''}
                  />
                )}

                {downstream.length > 0 && (
                  <>
                    <Connectors count={1} active={getStepStatus(runState.steps, heroIndex + 1) === 'running'} />
                    <div className="wfc-row">
                      {downstream.map((s, i) => (
                        <MiniNode
                          key={`dn-${i}`}
                          step={s}
                          edgeLabel={`→ step ${heroIndex + 2}`}
                          status={getStepStatus(runState.steps, heroIndex + 1)}
                          onClick={() => setHeroIndex(heroIndex + 1)}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <BottomToolbar
              activeTab={'run'}
              onTab={() => { /* phase C */ }}
              runStatus={runState.status}
              starting={starting}
              onRun={run}
              onCancel={cancel}
              startError={startError}
            />
          </div>

          <Rail
            workflow={active}
            steps={steps}
            heroIndex={heroIndex}
            onPick={setHeroIndex}
            runState={runState}
            onRun={run}
            onCancel={cancel}
          />
        </div>
      )}
    </div>
  )
}

function ConductorHeader({
  workflows, active, onPick, running,
}: { workflows: WorkflowSummary[]; active: string | null; onPick: (n: string) => void; running: boolean }): JSX.Element {
  return (
    <div className="wfc-page-header">
      <div>
        <div className="title">Workflow Conductor</div>
        <div className="subtitle">Run an ordered chain of skills. Each card is a step; click to focus.</div>
      </div>
      <select
        className="picker"
        value={active ?? ''}
        onChange={(e) => onPick(e.target.value)}
        data-testid="wfc-workflow-picker"
      >
        {workflows.length === 0 ? <option value="">no workflows</option> :
          workflows.map((w) => (
            <option key={w.name} value={w.name}>{w.name} · {w.steps.length} steps</option>
          ))}
      </select>
      <div className="actions">
        {running ? <span className="wfc-hero-status wfc-status-running"><span className="dot" />running</span> : null}
      </div>
    </div>
  )
}

function HeroCard({ step, index, total, status, output }: {
  step: WorkflowStep; index: number; total: number; status: WorkflowStepStatus | 'idle'; output: string
}): JSX.Element {
  return (
    <div className="wfc-hero" data-testid={`wfc-hero-${index}`} style={accentForKind(step.kind)}>
      <div className="wfc-hero-header">
        <div className="wfc-hero-avatar">{kindGlyph(step.kind)}</div>
        <div className="wfc-hero-name">{step.kind}:{step.ref}</div>
        <span className={`wfc-hero-status wfc-status-${status}`}><span className="dot" />{status}</span>
      </div>
      <div className="wfc-hero-role">Step {index + 1} of {total} · {step.kind === 'skill' ? 'invokes a skill' : 'invokes a sub-workflow'}</div>
      <div className="wfc-hero-deploy">▸ {step.kind === 'skill' ? `<kbRoot>/skills/${step.ref}/SKILL.md` : `<kbRoot>/workflows/${step.ref}/WORKFLOW.md`}</div>

      <div className="wfc-hero-response">
        <div className="wfc-hero-response-label"><span>latest output</span></div>
        <pre className="wfc-hero-response-body" data-testid={`wfc-hero-output-${index}`}>{output || '(awaiting run)'}</pre>
      </div>

      <div className="wfc-hero-foot">
        <span className="wfc-hero-stat">step {index + 1}/{total}</span>
        <span className="wfc-hero-stat">kind {step.kind}</span>
        <span className="wfc-hero-stat">ref {step.ref}</span>
      </div>
    </div>
  )
}

function MiniNode({ step, edgeLabel, status, onClick }: {
  step: WorkflowStep; edgeLabel: string; status: WorkflowStepStatus | 'idle'; onClick: () => void
}): JSX.Element {
  return (
    <button className="wfc-mini" onClick={onClick} style={accentForKind(step.kind)} data-testid={`wfc-mini-${step.ref}`}>
      <span className="wfc-mini-edge">{edgeLabel}</span>
      <span className="wfc-mini-card">
        <span className="wfc-mini-avatar">{kindGlyph(step.kind, 11)}</span>
        <span className="wfc-mini-body">
          <span className="wfc-mini-name">{step.ref}</span>
          <span className={`wfc-mini-status wfc-status-${status}`}><span className="dot" /></span>
        </span>
      </span>
    </button>
  )
}

function Connectors({ count, active }: { count: number; active: boolean }): JSX.Element {
  return (
    <div className={`wfc-connectors ${active ? '' : 'idle'}`}>
      {Array.from({ length: Math.max(1, count) }).map((_, i) => (
        <span key={i} className="wfc-connector">
          <span className="wfc-connector-line" />
          <span className="wfc-connector-pulse" />
        </span>
      ))}
    </div>
  )
}

function BottomToolbar({
  activeTab, onTab, runStatus, starting, onRun, onCancel, startError,
}: {
  activeTab: string; onTab: (k: string) => void; runStatus: string; starting: boolean;
  onRun: () => void; onCancel: () => void; startError: string | null
}): JSX.Element {
  const isRunning = runStatus === 'running' || runStatus === 'queued'
  return (
    <div className="wfc-toolbar-wrap">
      <div className="wfc-toolbar">
        <button
          className={`wfc-tool ${isRunning ? 'active' : ''}`}
          onClick={isRunning ? onCancel : onRun}
          disabled={starting}
          data-testid="wfc-run-button"
        >
          {isRunning ? '■ Cancel' : starting ? '… Starting' : '▶ Run'}
        </button>
        {['Steps', 'Skills', 'Runs', 'Spec'].map((label) => (
          <button key={label} className={`wfc-tool ${activeTab === label.toLowerCase() ? 'active' : ''}`} onClick={() => onTab(label.toLowerCase())}>
            {label}
          </button>
        ))}
      </div>
      <div className="wfc-activity">
        <span style={{ fontSize: 11 }}>{startError ? `⚠ ${startError}` : `status: ${runStatus}`}</span>
      </div>
    </div>
  )
}

function Rail({
  workflow, steps, heroIndex, onPick, runState, onRun, onCancel,
}: {
  workflow: WorkflowSummary
  steps: WorkflowStep[]
  heroIndex: number
  onPick: (i: number) => void
  runState: ReturnType<typeof useWorkflowRun>['state']
  onRun: () => void
  onCancel: () => void
}): JSX.Element {
  const [tab, setTab] = useState<RailTab>('steps')
  const heroStep = steps[heroIndex]
  const heroState = runState.steps[heroIndex]
  const isRunning = runState.status === 'running' || runState.status === 'queued'
  const completed = useMemo(() => Object.values(runState.steps).filter((s) => s.status === 'completed').length, [runState.steps])

  return (
    <aside className="wfc-rail" data-testid="wfc-rail">
      <div className="wfc-rail-head">
        <div className="wfc-rail-avatar" style={accentForKind(heroStep?.kind)}>
          {kindGlyph(heroStep?.kind ?? 'skill', 14)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="wfc-rail-name">{workflow.name}</div>
          <div className="wfc-rail-role">{workflow.description ?? `${steps.length} steps`}</div>
        </div>
        <span className={`wfc-hero-status wfc-status-${runState.status}`}><span className="dot" />{runState.status}</span>
      </div>

      <div className="wfc-rail-meta">
        <div><span className="wfc-rail-meta-label">steps</span><span className="wfc-rail-meta-value">{steps.length}</span></div>
        <div><span className="wfc-rail-meta-label">done</span><span className="wfc-rail-meta-value">{completed}/{steps.length}</span></div>
        <div><span className="wfc-rail-meta-label">run id</span><span className="wfc-rail-meta-value">{runState.runId ? runState.runId.slice(0, 8) : '—'}</span></div>
      </div>

      <div className="wfc-rail-tabs">
        {(['output', 'steps', 'spec'] as const).map((t) => (
          <button key={t} className={`wfc-rail-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'output' ? 'Output' : t === 'steps' ? 'Steps' : 'Spec'}
          </button>
        ))}
      </div>

      {tab === 'output' && (
        <div className="wfc-rail-section">
          <div className="wfc-rail-toolbar">
            <span>step {heroIndex + 1} · {heroStep?.kind}:{heroStep?.ref}</span>
            <span style={{ marginLeft: 'auto' }}>{heroState?.status ?? 'idle'}</span>
          </div>
          <pre className="wfc-response">{heroState?.output || '(no output yet — click ▶ Run in the canvas)'}</pre>
          {heroState?.error ? <pre className="wfc-response" style={{ borderLeftColor: 'var(--red)' }}>{heroState.error}</pre> : null}
        </div>
      )}

      {tab === 'steps' && (
        <div className="wfc-rail-section">
          <div className="wfc-step-list">
            {steps.map((s, i) => {
              const st = getStepStatus(runState.steps, i)
              return (
                <button key={i} className={`wfc-step-row ${i === heroIndex ? 'active' : ''}`} onClick={() => onPick(i)} data-testid={`wfc-step-row-${i}`}>
                  <span className="wfc-step-row-index">{i + 1}.</span>
                  <span className="wfc-step-row-body">
                    <span className="wfc-step-row-name">{s.ref}</span>
                    <span className="wfc-step-row-kind">{s.kind}</span>
                  </span>
                  <span className={`wfc-mini-status wfc-status-${st}`}><span className="dot" /></span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {tab === 'spec' && <SpecTab name={workflow.name} />}

      <div className="wfc-rail-foot">
        {isRunning
          ? <button className="btn btn-ghost" onClick={onCancel} data-testid="wfc-rail-cancel">■ Cancel</button>
          : <button className="btn btn-primary" onClick={onRun} data-testid="wfc-rail-run">▶ Run now</button>}
      </div>
    </aside>
  )
}

function SpecTab({ name }: { name: string }): JSX.Element {
  const [body, setBody] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setBody(null); setErr(null)
    getWorkflow(name).then((d) => { if (!cancelled) setBody(d.body || '(no body)') }).catch((e: Error) => { if (!cancelled) setErr(e.message) })
    return () => { cancelled = true }
  }, [name])
  return (
    <div className="wfc-rail-section">
      {err ? <div className="chat-msg-error">{err}</div> : null}
      <pre className="wfc-response">{body ?? 'loading…'}</pre>
    </div>
  )
}

/* ===== helpers ===== */

function getStepStatus(steps: Record<number, { status: WorkflowStepStatus }>, i: number): WorkflowStepStatus | 'idle' {
  return steps[i]?.status ?? 'idle'
}

function accentForKind(kind: 'skill' | 'workflow' | undefined): React.CSSProperties {
  if (kind === 'workflow') return { ['--k' as never]: '#a78bfa', ['--kbg' as never]: 'rgba(167,139,250,0.10)' }
  return {} // default cyan from CSS
}

function kindGlyph(kind: 'skill' | 'workflow', _size = 16): string {
  // text glyphs to keep the file dependency-free
  return kind === 'workflow' ? '↳' : '◆'
}
