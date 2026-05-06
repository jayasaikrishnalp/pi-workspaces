/**
 * Teams (formerly Swarm) — multi-agent routing preview. Backend lands as
 * a follow-up change. The other phase-8 PREVIEW screens (Files, Operations,
 * Conductor) were removed: Files+Operations dropped per scope cut,
 * Conductor renamed to Workflows and wired to the real /api/workflows.
 */

interface PreviewProps { title: string; subtitle: string; children: React.ReactNode; testId: string }

function PreviewShell({ title, subtitle, children, testId }: PreviewProps): JSX.Element {
  return (
    <div className="kb-screen" data-testid={testId}>
      <div className="kb-header">
        <h2>{title} <span className="preview-badge">PREVIEW</span></h2>
        <div className="kb-meta">{subtitle}</div>
      </div>
      {children}
    </div>
  )
}

export function TeamsScreen(): JSX.Element {
  const workers = [
    { id: 'aws-ops', role: 'AWS cleanup', status: 'ready' },
    { id: 'rds-doctor', role: 'Postgres incidents', status: 'running' },
    { id: 'patch-fleet', role: 'RHEL patching', status: 'ready' },
    { id: 'logs-grep', role: 'Loki queries', status: 'review' },
    { id: 'tf-planner', role: 'Terraform plans', status: 'blocked' },
    { id: 'k8s-on-call', role: 'EKS triage', status: 'running' },
  ]
  return (
    <PreviewShell title="Teams" subtitle="multi-agent routing — backend lands as a follow-up change" testId="screen-teams-preview">
      <div className="dash-grid">
        {workers.map((w) => (
          <div key={w.id} className="dash-card">
            <div className="dash-card-label">{w.id}</div>
            <div className="dash-card-value" style={{ fontSize: 14 }}>{w.role}</div>
            <div className="dash-card-hint">
              <span className={`dash-row-status status-${w.status === 'ready' ? 'todo' : w.status === 'running' ? 'running' : w.status === 'review' ? 'blocked' : 'blocked'}`}>{w.status}</span>
            </div>
          </div>
        ))}
      </div>
    </PreviewShell>
  )
}
