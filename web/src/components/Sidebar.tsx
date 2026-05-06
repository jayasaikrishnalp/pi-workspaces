import { useState, type ReactNode } from 'react'
import { Icons, Logo } from './icons/Icons'

export type ScreenId =
  | 'dashboard' | 'chat' | 'terminal' | 'jobs' | 'tasks'
  | 'workflows' | 'teams'
  | 'graph' | 'kb' | 'memory' | 'skills' | 'confluence' | 'mcp' | 'souls'
  | 'secrets'
  | 'sessions'

interface Props {
  active: ScreenId
  onPick: (id: ScreenId) => void
  collapsed: boolean
  setCollapsed: (v: boolean) => void
  skillCount?: number
  taskCount?: number
  teamsCount?: number
  workflowsCount?: number
  wikiCount?: number
  recentSessions?: Array<{ id: string; title: string; ago: string }>
  onCommandPalette?: () => void
  onSettings?: () => void
  onThemeToggle?: () => void
}

interface SidebarItemProps {
  icon: ReactNode
  label: string
  active: boolean
  onClick: () => void
  badge?: ReactNode
}

function SidebarItem({ icon, label, active, onClick, badge }: SidebarItemProps): JSX.Element {
  return (
    <button
      className={`sb-item ${active ? 'active' : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      data-testid={`sb-item-${label.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <span className="sb-icon">{icon}</span>
      <span className="sb-label">{label}</span>
      {badge ? <span className="sb-badge">{badge}</span> : null}
    </button>
  )
}

interface SidebarGroupProps {
  label: string
  defaultOpen?: boolean
  children: ReactNode
}

function SidebarGroup({ label, defaultOpen = true, children }: SidebarGroupProps): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="sb-group">
      <button className="sb-group-head" onClick={() => setOpen(!open)} data-testid={`sb-group-${label.toLowerCase()}`}>
        <span>{label}</span>
        <span className={`sb-chev ${open ? 'open' : ''}`}>
          <Icons.chev size={10} />
        </span>
      </button>
      {open ? <div className="sb-group-body">{children}</div> : null}
    </div>
  )
}

export function Sidebar(props: Props): JSX.Element {
  const { active, onPick, collapsed, setCollapsed, skillCount, taskCount, teamsCount, workflowsCount, wikiCount, recentSessions = [], onCommandPalette } = props

  if (collapsed) {
    return (
      <div className="sidebar collapsed" data-testid="sidebar-collapsed">
        <button className="sb-logo-btn" onClick={() => setCollapsed(false)} title="Expand sidebar" data-testid="sb-expand">
          <Logo size={20} />
        </button>
        {([
          { id: 'dashboard', icon: <Icons.dashboard size={16} /> },
          { id: 'chat', icon: <Icons.chat size={16} /> },
          { id: 'teams', icon: <Icons.swarm size={16} /> },
          { id: 'graph', icon: <Icons.graph size={16} /> },
          { id: 'workflows', icon: <Icons.conductor size={16} /> },
          { id: 'tasks', icon: <Icons.tasks size={16} /> },
          { id: 'jobs', icon: <Icons.jobs size={16} /> },
        ] as const).map((t) => (
          <button
            key={t.id}
            className={`sb-mini ${active === t.id ? 'active' : ''}`}
            onClick={() => onPick(t.id)}
            title={t.id}
          >
            {t.icon}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="sidebar" data-testid="sidebar-expanded">
      <div className="sb-header">
        <Logo size={18} />
        <span className="sb-title">Hive Workspace</span>
        <button className="sb-collapse" onClick={() => setCollapsed(true)} title="Collapse" data-testid="sb-collapse">
          <Icons.chev size={12} className="rev" />
        </button>
      </div>

      <button className="sb-cta" onClick={() => onPick('chat')} data-testid="sb-new-session">
        <Icons.plus size={13} /> New Session
      </button>
      <button className="sb-cta secondary" onClick={() => onCommandPalette?.()} data-testid="sb-search">
        <Icons.search size={12} /> Search… <kbd>⌘K</kbd>
      </button>
      <button className="sb-world" onClick={() => onPick('dashboard')}>
        <span className="sb-world-icon">π</span>
        <span>HiveWorld</span>
        <span className="sb-pill">NEW</span>
      </button>

      <SidebarGroup label="MAIN">
        <SidebarItem icon={<Icons.dashboard size={14} />} label="Dashboard" active={active === 'dashboard'} onClick={() => onPick('dashboard')} />
        <SidebarItem icon={<Icons.chat size={14} />} label="Chat" active={active === 'chat'} onClick={() => onPick('chat')} />
        <SidebarItem icon={<Icons.jobs size={14} />} label="Jobs" active={active === 'jobs'} onClick={() => onPick('jobs')} />
        <SidebarItem
          icon={<Icons.tasks size={14} />}
          label="Tasks"
          active={active === 'tasks'}
          onClick={() => onPick('tasks')}
          badge={taskCount ? <span className="sb-num">{taskCount}</span> : null}
        />
        <SidebarItem
          icon={<Icons.conductor size={14} />}
          label="Workflows"
          active={active === 'workflows'}
          onClick={() => onPick('workflows')}
          badge={workflowsCount ? <span className="sb-num">{workflowsCount}</span> : null}
        />
        <SidebarItem
          icon={<Icons.swarm size={14} />}
          label="Teams"
          active={active === 'teams'}
          onClick={() => onPick('teams')}
          badge={teamsCount ? <span className="sb-num">{teamsCount}</span> : null}
        />
      </SidebarGroup>

      <SidebarGroup label="KNOWLEDGE">
        <SidebarItem
          icon={<Icons.graph size={14} />}
          label="DAG"
          active={active === 'graph'}
          onClick={() => onPick('graph')}
          badge={typeof skillCount === 'number' ? <span className="sb-num">{skillCount}</span> : null}
        />
        <SidebarItem
          icon={<Icons.book size={14} />}
          label="Knowledge Base"
          active={active === 'kb'}
          onClick={() => onPick('kb')}
          badge={typeof wikiCount === 'number' && wikiCount > 0 ? <span className="sb-num">{wikiCount}</span> : null}
        />
        <SidebarItem icon={<Icons.memory size={14} />} label="Memory" active={active === 'memory'} onClick={() => onPick('memory')} />
        <SidebarItem icon={<Icons.book size={14} />} label="Skills" active={active === 'skills'} onClick={() => onPick('skills')} />
        <SidebarItem icon={<Icons.search size={14} />} label="Confluence" active={active === 'confluence'} onClick={() => onPick('confluence')} />
        <SidebarItem icon={<Icons.mcp size={14} />} label="MCP" active={active === 'mcp'} onClick={() => onPick('mcp')} />
        <SidebarItem icon={<span style={{fontSize:14}}>🔑</span>} label="Secrets" active={active === 'secrets'} onClick={() => onPick('secrets')} />
        <SidebarItem icon={<Icons.profiles size={14} />} label="Souls" active={active === 'souls'} onClick={() => onPick('souls')} />
      </SidebarGroup>

      <SidebarGroup label="SESSIONS">
        {recentSessions.length === 0 ? (
          <div className="sb-session-empty">no sessions yet</div>
        ) : recentSessions.slice(0, 5).map((s) => (
          <button key={s.id} className="sb-session" onClick={() => onPick('sessions')} data-testid={`sb-session-${s.id.slice(-6)}`}>
            <span className="sb-session-dot" />
            <span className="sb-session-text">{s.title}</span>
            <span className="sb-session-ago">{s.ago}</span>
          </button>
        ))}
        <button className="sb-session ghost" onClick={() => onPick('sessions')} data-testid="sb-item-sessions">
          <Icons.history size={11} /> All sessions →
        </button>
      </SidebarGroup>

      <div className="sb-footer">
        <button className="sb-user">
          <span className="sb-avatar">JK</span>
          <span className="sb-user-name">jaya · on-call</span>
          <span className="sb-status-dot" />
        </button>
        <div className="sb-footer-actions">
          <button className="sb-iconbtn" title="Settings" onClick={() => props.onSettings?.()} data-testid="sb-settings"><Icons.settings size={12} /></button>
          <button className="sb-iconbtn" title="Toggle light/dark" onClick={() => props.onThemeToggle?.()} data-testid="sb-theme-toggle"><Icons.spark size={12} /></button>
        </div>
      </div>
    </div>
  )
}
