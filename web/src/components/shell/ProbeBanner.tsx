import type { ProbeResponse } from '../../lib/api'

interface Props {
  probe: ProbeResponse | null
  loading?: boolean
}

interface Pill { label: string; value: string; ok: boolean }

export function ProbeBanner({ probe, loading }: Props): JSX.Element {
  if (loading && !probe) {
    return <div className="probe-banner" data-testid="probe-banner-loading">Probing workspace…</div>
  }
  if (!probe) return <div className="probe-banner" data-testid="probe-banner-empty" />
  const pills: Pill[] = [
    { label: 'pi', value: probe.pi.ok ? (probe.pi.version ?? 'ok') : (probe.pi.error ?? 'down'), ok: probe.pi.ok },
    { label: 'confluence', value: probe.confluence.configured ? 'linked' : 'unset', ok: probe.confluence.configured },
    { label: 'auth.json', value: probe.auth.piAuthJsonPresent ? 'ok' : 'missing', ok: probe.auth.piAuthJsonPresent },
    { label: 'skills', value: `${probe.skills.count} loaded`, ok: true },
    { label: 'souls', value: `${probe.souls?.count ?? 0}`, ok: true },
    { label: 'jobs', value: `${probe.jobs?.count ?? 0}`, ok: true },
    { label: 'mcp', value: `${(probe.mcp?.servers ?? []).length}`, ok: (probe.mcp?.servers ?? []).every((s) => s.status !== 'error') },
  ]
  return (
    <div className="probe-banner" data-testid="probe-banner">
      {pills.map((p) => (
        <span key={p.label} className={`probe-pill ${p.ok ? 'ok' : 'err'}`} data-testid={`probe-pill-${p.label}`}>
          <span className="probe-label">{p.label}</span>
          <span className="probe-value">{p.value}</span>
        </span>
      ))}
    </div>
  )
}
