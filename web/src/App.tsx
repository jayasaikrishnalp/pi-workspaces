import { useCallback, useEffect, useState } from 'react'

import { Sidebar, type ScreenId } from './components/Sidebar'
import { Titlebar } from './components/shell/Titlebar'
import { Statusbar } from './components/shell/Statusbar'
import { ProbeBanner } from './components/shell/ProbeBanner'
import { PlaceholderScreen } from './components/screens/PlaceholderScreen'
import { DashboardScreen } from './components/screens/DashboardScreen'
import { ChatScreen } from './components/screens/ChatScreen'
import { GraphScreen } from './components/screens/GraphScreen'
import { KnowledgeBaseScreen } from './components/screens/KnowledgeBaseScreen'
import { SkillsScreen } from './components/screens/SkillsScreen'
import { AgentsScreen } from './components/screens/AgentsScreen'
import { loadAgents, saveAgents, type Agent } from './lib/agents-store'
import { MemoryScreen } from './components/screens/MemoryScreen'
import { JobsScreen } from './components/screens/JobsScreen'
import { TasksScreen } from './components/screens/TasksScreen'
import { TerminalScreen } from './components/screens/TerminalScreen'
import { McpScreen } from './components/screens/McpScreen'
import { SecretsScreen } from './components/screens/SecretsScreen'
import { ConfluenceScreen } from './components/screens/ConfluenceScreen'
import { TeamsScreen } from './components/screens/PreviewScreens'
import { WorkflowsScreen } from './components/screens/WorkflowsScreen'
import { SessionsScreen } from './components/screens/SessionsScreen'
import { Settings } from './components/overlays/Settings'
import { CommandPalette } from './components/overlays/CommandPalette'
import { Shortcuts } from './components/overlays/Shortcuts'
import { SaveSkillModal } from './components/overlays/SaveSkillModal'
import { ToastStack, type Toast } from './components/overlays/ToastStack'
import { Login } from './components/Login'
import { useApi } from './hooks/useApi'
import { probe, listSessions } from './lib/api'

const PREVIEW_SCREENS: ReadonlySet<ScreenId> = new Set(['teams'])

const STORAGE = {
  active: 'hive.activeScreen',
  collapsed: 'hive.sidebarCollapsed',
  vibe: 'hive.vibe',
}

function loadActive(): ScreenId {
  const v = localStorage.getItem(STORAGE.active)
  // Migrate dropped/renamed screens to their replacements.
  const migrated: Record<string, ScreenId> = { files: 'dashboard', ops: 'dashboard', conductor: 'workflows', swarm: 'teams', souls: 'agents' }
  if (v && migrated[v]) return migrated[v]!
  return (v as ScreenId | null) ?? 'dashboard'
}
function loadCollapsed(): boolean { return localStorage.getItem(STORAGE.collapsed) === '1' }
function loadVibe(): string { return localStorage.getItem(STORAGE.vibe) ?? 'default' }

function shortAgo(ts: number): string {
  const d = Date.now() - ts
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  return `${Math.floor(d / 86_400_000)}d`
}

export function App(): JSX.Element {
  const [active, setActive] = useState<ScreenId>(loadActive)
  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed)
  const [vibe, setVibe] = useState<string>(loadVibe)
  const [agents, setAgents] = useState<Agent[]>(loadAgents)
  useEffect(() => { saveAgents(agents) }, [agents])
  // Workflow run state surfaced from WorkflowsScreen so we can lock the chat
  // composer while a run is in flight. Pi serializes globally — chat sends
  // would otherwise return BRIDGE_BUSY mid-workflow.
  const [chatLockedReason, setChatLockedReason] = useState<string | null>(null)
  const probeState = useApi('probe', probe)
  const sessionsState = useApi('app.sessions', listSessions)

  const [cmdkOpen, setCmdkOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [saveSkillOpen, setSaveSkillOpen] = useState(false)
  const [saveSkillBody, setSaveSkillBody] = useState('')

  const [toasts, setToasts] = useState<Toast[]>([])
  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setToasts((arr) => [...arr, { id, ...t }])
  }, [])
  const dismissToast = useCallback((id: string) => setToasts((arr) => arr.filter((x) => x.id !== id)), [])

  // Wire the "Run now" button on Scheduled Jobs: switch to the chat screen
  // and re-broadcast the prompt as a seed for the Composer to pick up.
  useEffect(() => {
    const onRunJob = (e: Event) => {
      const detail = (e as CustomEvent).detail as { prompt?: string; skills?: string[]; name?: string } | undefined
      if (!detail?.prompt) return
      setActive('chat')
      pushToast({ kind: 'info', title: `Running "${detail.name ?? 'job'}"`, message: 'Prompt loaded into chat. Hit Send to dispatch.' })
      // Defer the seed event to the next tick so ChatScreen has mounted.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('hive:chat-seed', { detail: { text: detail.prompt, skills: detail.skills } }))
      }, 50)
    }
    window.addEventListener('hive:run-job', onRunJob)
    return () => window.removeEventListener('hive:run-job', onRunJob)
  }, [pushToast])

  useEffect(() => {
    document.body.className = vibe === 'default' ? '' : `vibe-${vibe}`
    localStorage.setItem(STORAGE.vibe, vibe)
  }, [vibe])

  useEffect(() => { localStorage.setItem(STORAGE.active, active) }, [active])
  useEffect(() => { localStorage.setItem(STORAGE.collapsed, collapsed ? '1' : '0') }, [collapsed])

  const toggleTheme = useCallback(() => {
    setVibe((v) => (v === 'light' ? 'default' : 'light'))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdkOpen((v) => !v) }
      else if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); setSettingsOpen(true) }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); setCollapsed((v) => !v) }
      else if (e.key === '?' && !inField) { e.preventDefault(); setShortcutsOpen(true) }
      else if (e.key === 'Escape') {
        setCmdkOpen(false); setSettingsOpen(false); setShortcutsOpen(false); setSaveSkillOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (probeState.unauthorized) {
    return <Login onLoggedIn={() => probeState.reload()} />
  }

  const isPreview = PREVIEW_SCREENS.has(active)
  const skillsCount = probeState.data?.skills.count
  const tasksCount = probeState.data?.tasks?.count
  const workflowsCount = probeState.data?.workflows?.count
  const wikiCount = probeState.data?.wiki?.count

  const recentSessions = (sessionsState.data?.sessions ?? [])
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)
    .map((s) => ({ id: s.sessionKey, title: s.sessionKey.slice(0, 8), ago: shortAgo(s.createdAt) }))

  return (
    <div
      className={`workspace-shell ${collapsed ? 'collapsed' : ''}`}
      data-testid="workspace-shell"
      data-active={active}
      data-vibe={vibe}
    >
      <Sidebar
        active={active}
        onPick={(id) => setActive(id)}
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        skillCount={skillsCount}
        taskCount={tasksCount}
        workflowsCount={workflowsCount}
        wikiCount={wikiCount}
        agentsCount={agents.length}
        recentSessions={recentSessions}
        onCommandPalette={() => setCmdkOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onThemeToggle={toggleTheme}
      />
      <Titlebar
        crumbs={['hive', 'vm-prod-43', titleFor(active)]}
        onCmdK={() => setCmdkOpen(true)}
        onShortcuts={() => setShortcutsOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />
      <div className="main-area">
        <ProbeBanner probe={probeState.data} loading={probeState.loading} />
        <div className="main-content">
          {active === 'dashboard' ? <DashboardScreen onPick={setActive} />
            : active === 'chat'      ? <ChatScreen onSaveSkill={(body) => { setSaveSkillBody(body); setSaveSkillOpen(true) }} lockedReason={chatLockedReason} />
            : active === 'graph'     ? <GraphScreen />
            : active === 'kb'        ? <KnowledgeBaseScreen />
            : active === 'skills'    ? <SkillsScreen />
            : active === 'agents'    ? <AgentsScreen roster={agents} setRoster={setAgents} />
            : active === 'memory'    ? <MemoryScreen />
            : active === 'jobs'      ? <JobsScreen />
            : active === 'tasks'     ? <TasksScreen />
            : active === 'terminal'  ? <TerminalScreen />
            : active === 'mcp'       ? <McpScreen />
            : active === 'secrets'   ? <SecretsScreen />
            : active === 'confluence'? <ConfluenceScreen />
            : active === 'workflows' ? (
              <WorkflowsScreen
                onRunStateChange={(info) => {
                  setChatLockedReason(
                    info.running
                      ? `Workflow "${info.workflowName ?? 'unknown'}" running${info.activeStepId ? ` · step ${info.activeStepId}` : ''}…`
                      : null,
                  )
                }}
              />
            )
            : active === 'teams'     ? <TeamsScreen />
            : active === 'sessions'  ? <SessionsScreen onPick={setActive} />
            : <PlaceholderScreen id={active} preview={isPreview} />}
        </div>
      </div>
      <Statusbar probe={probeState.data} />

      <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} onPick={(id) => setActive(id)} />
      <Shortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} vibe={vibe} setVibe={setVibe} />
      <SaveSkillModal
        open={saveSkillOpen}
        onClose={() => setSaveSkillOpen(false)}
        onSaved={(name) => {
          setSaveSkillOpen(false)
          pushToast({ kind: 'success', title: 'Skill saved', message: `${name} written to <kbRoot>/skills/` })
          setActive('graph')
        }}
        initialBody={saveSkillBody}
      />
      <ToastStack toasts={toasts} dismiss={dismissToast} />
    </div>
  )
}

function titleFor(id: ScreenId): string {
  const m: Record<ScreenId, string> = {
    dashboard: 'dashboard', chat: 'chat', terminal: 'terminal',
    jobs: 'jobs', tasks: 'tasks', workflows: 'workflows', teams: 'teams',
    graph: 'dag', kb: 'knowledge.base', memory: 'memory', skills: 'skills', confluence: 'confluence',
    mcp: 'mcp', secrets: 'secrets', agents: 'agents', sessions: 'sessions',
  }
  return m[id]
}
