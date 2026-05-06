import { useState } from 'react'
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip,
} from 'recharts'

import { useApi } from '../../hooks/useApi'
import { fetchDashboardIntelligence, type DashboardIntelligence } from '../../lib/api'
import type { ScreenId } from '../Sidebar'

interface Props { onPick?: (id: ScreenId) => void }

type Window = 7 | 14 | 30

export function DashboardScreen({ onPick }: Props = {}): JSX.Element {
  const [windowDays, setWindowDays] = useState<Window>(7)
  const intel = useApi(`dash.intel.${windowDays}`, () => fetchDashboardIntelligence(windowDays))
  const data = intel.data ?? null

  return (
    <div className="dashboard" data-testid="dashboard" data-window={windowDays}>
      <div className="dash-header">
        <div>
          <h2>Dashboard</h2>
          <div className="dash-sub">
            session intelligence · last {windowDays} days
            {data?.activeModel ? ` · active: ${data.activeModel}` : ''}
          </div>
          <div className="dash-quick-actions" data-testid="dash-quick-actions">
            <button className="btn btn-primary" onClick={() => onPick?.('chat')} data-testid="dash-action-chat">NEW CHAT →</button>
            <button className="btn btn-secondary" onClick={() => onPick?.('terminal')} data-testid="dash-action-terminal">TERMINAL →</button>
            <button className="btn btn-secondary" onClick={() => onPick?.('skills')} data-testid="dash-action-skills">SKILLS →</button>
            <button className="btn btn-ghost" onClick={() => onPick?.('graph')} data-testid="dash-action-graph">GRAPH →</button>
          </div>
        </div>
        <div className="dash-window-toggle" data-testid="dash-window-toggle">
          {([7, 14, 30] as Window[]).map((w) => (
            <button key={w}
              className={`dash-window-btn ${w === windowDays ? 'active' : ''}`}
              onClick={() => setWindowDays(w)}
              data-testid={`dash-window-${w}d`}
            >{w}D</button>
          ))}
        </div>
      </div>

      {!data ? <div className="dash-empty">loading dashboard…</div> : (
        <>
          <HeroStats data={data} />
          <div className="dash-row-2col">
            <UsageTrend data={data} />
            <TopModels data={data} />
          </div>
          <div className="dash-row-2col">
            <SessionsIntel data={data} />
            <CacheContribution data={data} />
          </div>
          <div className="dash-row-2col">
            <MixRhythm data={data} />
            <ToolsUsage data={data} />
          </div>
        </>
      )}
    </div>
  )
}

function fmtN(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function HeroStats({ data }: { data: DashboardIntelligence }): JSX.Element {
  const totalTokens = data.tokenTotals.input + data.tokenTotals.output + data.tokenTotals.cacheRead
  return (
    <div className="dash-hero" data-testid="dash-hero">
      <HeroCard label="SESSIONS" value={String(data.sessionsCount)} hint={`${data.windowDays}D · ${data.sessionsIntelligence.length} active`} testId="hero-sessions" />
      <HeroCard label="TOKENS" value={fmtN(totalTokens)} hint={`${fmtN(data.tokenTotals.cacheRead)} cached`} testId="hero-tokens" />
      <HeroCard label="API CALLS" value={String(data.apiCallsCount)} hint={`${data.windowDays}D window`} testId="hero-api-calls" />
      <HeroCard label="ACTIVE MODEL" value={data.activeModel ?? '—'} hint={`${data.topModels[0]?.sessions ?? 0} sessions`} testId="hero-model" small />
    </div>
  )
}

function HeroCard({ label, value, hint, testId, small }: { label: string; value: string; hint: string; testId: string; small?: boolean }): JSX.Element {
  return (
    <div className="hero-card" data-testid={testId}>
      <div className="hero-label">{label}</div>
      <div className={`hero-value ${small ? 'small' : ''}`}>{value}</div>
      <div className="hero-hint">{hint}</div>
    </div>
  )
}

function UsageTrend({ data }: { data: DashboardIntelligence }): JSX.Element {
  const series = data.usageTrend.map((p) => ({ bucket: p.bucket.slice(5), tokens: p.tokensTotal, cache: p.cacheRead }))
  const peak = series.reduce((m, p) => p.tokens > m.tokens ? p : m, { bucket: '', tokens: 0 })
  const totalTokens = series.reduce((s, p) => s + p.tokens, 0)
  const totalCost = data.usageTrend.reduce((s, p) => s + p.cost, 0)
  const topTool = data.usageTrend.find((p) => p.topTool)?.topTool ?? null

  return (
    <div className="dash-panel dash-usage-trend" data-testid="dash-usage-trend">
      <div className="dash-panel-head">
        <span className="kk-label-tiny">USAGE TREND · {data.windowDays}D</span>
        <span className="dash-panel-meta">{fmtN(totalTokens)} tokens · ${totalCost.toFixed(2)}</span>
      </div>
      <ul className="dash-callouts">
        {peak.tokens > 0 ? <li>Peak {peak.bucket}: {fmtN(peak.tokens)} tokens</li> : <li>No activity in window</li>}
        {topTool ? <li>Top tool: <code>{topTool}</code></li> : null}
      </ul>
      <div style={{ height: 200, marginTop: 8 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="bucket" stroke="var(--text-secondary)" fontSize={10} />
            <YAxis stroke="var(--text-secondary)" fontSize={10} />
            <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6 }} />
            <Line type="monotone" dataKey="tokens" stroke="var(--accent)" strokeWidth={2} dot={false} name="tokens" />
            <Line type="monotone" dataKey="cache" stroke="var(--accent-cyan)" strokeWidth={1.5} dot={false} strokeDasharray="4 4" name="cache reads" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function TopModels({ data }: { data: DashboardIntelligence }): JSX.Element {
  const max = Math.max(1, ...data.topModels.map((m) => m.tokens))
  return (
    <div className="dash-panel" data-testid="dash-top-models">
      <div className="dash-panel-head">
        <span className="kk-label-tiny">TOP MODELS · {data.windowDays}D</span>
        <span className="dash-panel-meta">{data.topModels.length} ranked</span>
      </div>
      {data.topModels.length === 0 ? <div className="dash-empty">no model traffic yet</div> : (
        <div className="dash-rows">
          {data.topModels.map((m, i) => (
            <div key={m.model} className="ranked-row" data-testid={`top-model-${m.model}`}>
              <div className="ranked-row-head">
                <span className="ranked-num">{i + 1}</span>
                <span className="ranked-name">{m.model}</span>
                <span className="ranked-meta">{fmtN(m.tokens)}</span>
              </div>
              <div className="ranked-bar"><div className="ranked-bar-fill" style={{ width: `${(m.tokens / max) * 100}%` }} /></div>
              <div className="ranked-sub">{m.sessions} session{m.sessions === 1 ? '' : 's'} · ${m.costUsd.toFixed(2)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CacheContribution({ data }: { data: DashboardIntelligence }): JSX.Element {
  const pct = (data.cacheContribution * 100).toFixed(1)
  const ratio = data.tokenTotals.input > 0 ? (data.tokenTotals.cacheRead / data.tokenTotals.input).toFixed(1) : '—'
  return (
    <div className="dash-panel" data-testid="dash-cache">
      <div className="dash-panel-head">
        <span className="kk-label-tiny">CACHE CONTRIBUTION · {data.windowDays}D</span>
      </div>
      <div className="cache-big">{pct}<span style={{ fontSize: '0.5em' }}>%</span></div>
      <div className="dash-empty" style={{ padding: 0, marginTop: 4 }}>
        {fmtN(data.tokenTotals.cacheRead)} cache read / {fmtN(data.tokenTotals.input)} input · {ratio}× ratio
      </div>
      <div className="cache-note">
        cache_read / (cache_read + cache_write + tokens_in). Anthropic's cache mechanic blurs "hit rate"; we report contribution.
      </div>
    </div>
  )
}

function SessionsIntel({ data }: { data: DashboardIntelligence }): JSX.Element {
  return (
    <div className="dash-panel" data-testid="dash-sessions-intel">
      <div className="dash-panel-head">
        <span className="kk-label-tiny">SESSIONS INTELLIGENCE</span>
        <span className="dash-panel-meta">{data.sessionsIntelligence.length} sessions</span>
      </div>
      {data.sessionsIntelligence.length === 0 ? <div className="dash-empty">no sessions in window</div> : (
        <div className="dash-rows" style={{ maxHeight: 320, overflowY: 'auto' }}>
          {data.sessionsIntelligence.map((s) => (
            <div key={s.sessionId} className="sess-row" data-testid={`sess-row-${s.sessionId.slice(-6)}`}>
              <div className="sess-row-title">
                <span className="sess-title">{s.title}</span>
                {s.tags.map((t) => <span key={t} className={`sess-tag tag-${t.toLowerCase()}`}>{t}</span>)}
              </div>
              <div className="sess-row-meta">
                {s.predominantModel ? <span className="sess-model">{s.predominantModel}</span> : null}
                <span>{s.msgCount} msgs</span>
                {s.toolCount > 0 ? <span>{s.toolCount} tools</span> : null}
                <span>{fmtN(s.tokensTotal)} tok</span>
                {s.costUsd > 0 ? <span>${s.costUsd.toFixed(4)}</span> : null}
                <span className="sess-ago">{s.agoText}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MixRhythm({ data }: { data: DashboardIntelligence }): JSX.Element {
  const total = data.tokenMix.input + data.tokenMix.output + data.tokenMix.cacheRead + data.tokenMix.cacheWrite || 1
  const pct = (n: number): string => `${((n / total) * 100).toFixed(1)}%`
  const series = data.hourOfDayHistogram.map((h) => ({ hour: String(h.hourUtc).padStart(2, '0'), count: h.count }))
  return (
    <div className="dash-panel" data-testid="dash-mix-rhythm">
      <div className="dash-panel-head">
        <span className="kk-label-tiny">MIX &amp; RHYTHM · {data.windowDays}D · UTC</span>
      </div>
      <div className="mix-bar">
        <div className="mix-seg cache"  style={{ flex: data.tokenMix.cacheRead || 0.0001 }}  title={`cache read: ${pct(data.tokenMix.cacheRead)}`} />
        <div className="mix-seg input"  style={{ flex: data.tokenMix.input || 0.0001 }}      title={`input: ${pct(data.tokenMix.input)}`} />
        <div className="mix-seg output" style={{ flex: data.tokenMix.output || 0.0001 }}     title={`output: ${pct(data.tokenMix.output)}`} />
        <div className="mix-seg write"  style={{ flex: data.tokenMix.cacheWrite || 0.0001 }} title={`cache write: ${pct(data.tokenMix.cacheWrite)}`} />
      </div>
      <div className="mix-legend">
        <span><span className="mix-dot cache"/>CACHE {pct(data.tokenMix.cacheRead)}</span>
        <span><span className="mix-dot input"/>INPUT {pct(data.tokenMix.input)}</span>
        <span><span className="mix-dot output"/>OUTPUT {pct(data.tokenMix.output)}</span>
        <span><span className="mix-dot write"/>WRITE {pct(data.tokenMix.cacheWrite)}</span>
      </div>
      <div style={{ height: 100, marginTop: 6 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={series}>
            <XAxis dataKey="hour" stroke="var(--text-secondary)" fontSize={9} interval={3} />
            <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6 }} />
            <Bar dataKey="count" fill="var(--accent)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function ToolsUsage({ data }: { data: DashboardIntelligence }): JSX.Element {
  const max = Math.max(1, ...data.topTools.map((t) => t.count))
  const total = data.topTools.reduce((s, t) => s + t.count, 0)
  return (
    <div className="dash-panel" data-testid="dash-tools-usage">
      <div className="dash-panel-head">
        <span className="kk-label-tiny">TOOLS USAGE · {data.windowDays}D</span>
        <span className="dash-panel-meta">{data.topTools.length} of {data.topTools.length} ranked</span>
      </div>
      {data.topTools.length === 0 ? <div className="dash-empty">no tool calls yet</div> : (
        <div className="dash-rows">
          {data.topTools.map((t) => (
            <div key={t.tool} className="ranked-row" data-testid={`tool-row-${t.tool}`}>
              <div className="ranked-row-head">
                <span className="ranked-name">{t.tool}</span>
                <span className="ranked-meta">{t.count} · {((t.count / total) * 100).toFixed(1)}%</span>
              </div>
              <div className="ranked-bar tool"><div className="ranked-bar-fill" style={{ width: `${(t.count / max) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
