import { useEffect, useState } from 'react'

import { Sidebar, type ScreenId } from './components/Sidebar'
import { Titlebar } from './components/shell/Titlebar'
import { Statusbar } from './components/shell/Statusbar'
import { ProbeBanner } from './components/shell/ProbeBanner'
import { PlaceholderScreen } from './components/screens/PlaceholderScreen'
import { DashboardScreen } from './components/screens/DashboardScreen'
import { ChatScreen } from './components/screens/ChatScreen'
import { GraphScreen } from './components/screens/GraphScreen'
import { SkillsScreen } from './components/screens/SkillsScreen'
import { SoulsScreen } from './components/screens/SoulsScreen'
import { MemoryScreen } from './components/screens/MemoryScreen'
import { JobsScreen } from './components/screens/JobsScreen'
import { TasksScreen } from './components/screens/TasksScreen'
import { TerminalScreen } from './components/screens/TerminalScreen'
import { Login } from './components/Login'
import { useApi } from './hooks/useApi'
import { probe } from './lib/api'

const PREVIEW_SCREENS: ReadonlySet<ScreenId> = new Set(['files', 'conductor', 'ops', 'swarm'])

const STORAGE = {
  active: 'hive.activeScreen',
  collapsed: 'hive.sidebarCollapsed',
  vibe: 'hive.vibe',
}

function loadActive(): ScreenId {
  const v = localStorage.getItem(STORAGE.active)
  return (v as ScreenId) ?? 'dashboard'
}

function loadCollapsed(): boolean {
  return localStorage.getItem(STORAGE.collapsed) === '1'
}

function loadVibe(): string {
  return localStorage.getItem(STORAGE.vibe) ?? 'default'
}

export function App(): JSX.Element {
  const [active, setActive] = useState<ScreenId>(loadActive)
  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed)
  const [vibe, _setVibe] = useState<string>(loadVibe)
  const probeState = useApi('probe', probe)

  // Apply vibe class to body.
  useEffect(() => {
    document.body.className = vibe === 'default' ? '' : `vibe-${vibe}`
  }, [vibe])

  // Persist screen + sidebar state.
  useEffect(() => { localStorage.setItem(STORAGE.active, active) }, [active])
  useEffect(() => { localStorage.setItem(STORAGE.collapsed, collapsed ? '1' : '0') }, [collapsed])

  if (probeState.unauthorized) {
    return <Login onLoggedIn={() => probeState.reload()} />
  }

  const isPreview = PREVIEW_SCREENS.has(active)
  const skillsCount = probeState.data?.skills.count
  const tasksCount = probeState.data?.tasks?.count

  return (
    <div
      className={`workspace-shell ${collapsed ? 'collapsed' : ''}`}
      data-testid="workspace-shell"
      data-active={active}
    >
      <Sidebar
        active={active}
        onPick={(id) => setActive(id)}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        skillCount={skillsCount}
        taskCount={tasksCount}
      />
      <Titlebar crumbs={['hive', 'vm-prod-43', titleFor(active)]} />
      <div className="main-area">
        <ProbeBanner probe={probeState.data} loading={probeState.loading} />
        <div className="main-content">
          {active === 'dashboard' ? (
            <DashboardScreen />
          ) : active === 'chat' ? (
            <ChatScreen />
          ) : active === 'graph' ? (
            <GraphScreen />
          ) : active === 'skills' ? (
            <SkillsScreen />
          ) : active === 'souls' ? (
            <SoulsScreen />
          ) : active === 'memory' ? (
            <MemoryScreen />
          ) : active === 'jobs' ? (
            <JobsScreen />
          ) : active === 'tasks' ? (
            <TasksScreen />
          ) : active === 'terminal' ? (
            <TerminalScreen />
          ) : (
            <PlaceholderScreen id={active} preview={isPreview} />
          )}
        </div>
      </div>
      <Statusbar probe={probeState.data} />
    </div>
  )
}

function titleFor(id: ScreenId): string {
  const m: Record<ScreenId, string> = {
    dashboard: 'dashboard', chat: 'chat', files: 'files', terminal: 'terminal',
    jobs: 'jobs', tasks: 'tasks', conductor: 'conductor', ops: 'operations', swarm: 'swarm',
    graph: 'knowledge.graph', memory: 'memory', skills: 'skills', confluence: 'confluence',
    mcp: 'mcp', souls: 'souls', sessions: 'sessions',
  }
  return m[id]
}
