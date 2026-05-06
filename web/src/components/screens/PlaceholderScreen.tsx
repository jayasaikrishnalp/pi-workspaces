interface Props {
  id: string
  preview?: boolean
}

const SCREEN_TITLES: Record<string, string> = {
  dashboard: 'Dashboard',
  chat: 'Chat',
  files: 'Files',
  terminal: 'Terminal',
  jobs: 'Jobs',
  tasks: 'Tasks',
  conductor: 'Conductor',
  ops: 'Operations',
  swarm: 'Swarm',
  graph: 'Knowledge Graph',
  memory: 'Memory',
  skills: 'Skills',
  confluence: 'Confluence',
  mcp: 'MCP',
  souls: 'Souls',
  sessions: 'Sessions',
}

export function PlaceholderScreen({ id, preview }: Props): JSX.Element {
  return (
    <div className="preview-screen" data-testid={`screen-${id}`}>
      <h2>
        {SCREEN_TITLES[id] ?? id}
        {preview ? <span className="preview-badge">PREVIEW</span> : null}
      </h2>
      <p style={{ color: 'var(--text-secondary)' }}>
        {preview
          ? 'This screen is a design preview. Backend wiring lands in a follow-up change.'
          : 'Phase 1 — screen scaffold. Live data wiring lands in a later phase.'}
      </p>
    </div>
  )
}
