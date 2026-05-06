/**
 * Phase 8 — the four PREVIEW screens lifted in spirit from the design's
 * screens.jsx. They render mock data + a PREVIEW badge so the workspace
 * looks complete for stakeholder review while their backends ship as
 * follow-ups.
 */

import { Icons } from '../icons/Icons'

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

export function SwarmScreen(): JSX.Element {
  const workers = [
    { id: 'aws-ops', role: 'AWS cleanup', status: 'ready' },
    { id: 'rds-doctor', role: 'Postgres incidents', status: 'running' },
    { id: 'patch-fleet', role: 'RHEL patching', status: 'ready' },
    { id: 'logs-grep', role: 'Loki queries', status: 'review' },
    { id: 'tf-planner', role: 'Terraform plans', status: 'blocked' },
    { id: 'k8s-on-call', role: 'EKS triage', status: 'running' },
  ]
  return (
    <PreviewShell title="Swarm" subtitle="multi-agent routing — backend lands as a follow-up change" testId="screen-swarm-preview">
      <div className="dash-grid">
        {workers.map((w) => (
          <div key={w.id} className="dash-card">
            <div className="dash-card-label">{w.id}</div>
            <div className="dash-card-value" style={{ fontSize: 14 }}>{w.role}</div>
            <div className="dash-card-hint"><span className={`dash-row-status status-${w.status === 'ready' ? 'todo' : w.status === 'running' ? 'running' : w.status === 'review' ? 'blocked' : 'blocked'}`}>{w.status}</span></div>
          </div>
        ))}
      </div>
    </PreviewShell>
  )
}

export function ConductorScreen(): JSX.Element {
  return (
    <PreviewShell title="Conductor" subtitle="orchestration of multi-step workflows — preview only" testId="screen-conductor-preview">
      <div className="dash-empty" style={{ padding: 40 }}>
        <Icons.conductor size={48} />
        <p style={{ marginTop: 16 }}>Conductor batches workflows into runs and routes them through approval chains. Backend lands as <code>add-conductor</code> in a follow-up change.</p>
      </div>
    </PreviewShell>
  )
}

export function OperationsScreen(): JSX.Element {
  return (
    <PreviewShell title="Operations" subtitle="ops dashboard — preview only" testId="screen-ops-preview">
      <div className="dash-grid">
        <div className="dash-card"><div className="dash-card-label">UPTIME</div><div className="dash-card-value">99.7%</div><div className="dash-card-hint">last 30 days</div></div>
        <div className="dash-card"><div className="dash-card-label">P1 INCIDENTS</div><div className="dash-card-value">2</div><div className="dash-card-hint">resolved this month</div></div>
        <div className="dash-card"><div className="dash-card-label">MTTR</div><div className="dash-card-value">42m</div><div className="dash-card-hint">trailing 30d</div></div>
        <div className="dash-card"><div className="dash-card-label">ON-CALL</div><div className="dash-card-value" style={{ fontSize: 14 }}>jaya</div><div className="dash-card-hint">PagerDuty primary</div></div>
      </div>
    </PreviewShell>
  )
}

export function FilesScreen(): JSX.Element {
  const files = [
    { name: '/etc/nginx/sites-enabled/api.conf', size: '4.2 KB' },
    { name: '/var/log/syslog', size: '12 MB' },
    { name: '/home/sre/playbooks/reboot.yml', size: '821 B' },
    { name: '/opt/app/release/v3.7.2/manifest.json', size: '3.1 KB' },
  ]
  return (
    <PreviewShell title="Files" subtitle="remote file browser — preview only" testId="screen-files-preview">
      <div className="kb-list" style={{ maxHeight: 'none' }}>
        {files.map((f) => (
          <div key={f.name} className="kb-list-row" style={{ cursor: 'default' }}>
            <div className="kb-list-name"><Icons.files size={14}/> {f.name}</div>
            <div className="kb-list-desc">{f.size}</div>
          </div>
        ))}
      </div>
    </PreviewShell>
  )
}
