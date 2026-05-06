/**
 * Three kinds of entities live in the KB graph: skills, agents, workflows.
 * Memory files exist on disk but are intentionally NOT graph nodes — they
 * are operator-owned text, surfaced through /api/memory only.
 */
export type KbNodeKind = 'skill' | 'agent' | 'workflow'

export interface SkillNode {
  id: string
  name: string
  description?: string
  tags?: string[]
  /** Path relative to kbRoot (e.g. "skills/reboot-server/SKILL.md", "agents/sre-bot/AGENT.md"). */
  path: string
  source: KbNodeKind
}

export interface SkillEdge {
  source: string
  target: string
  /**
   * - `uses`: skill → skill, derived from frontmatter `uses:` array
   * - `link`: skill → skill, derived from a body wikilink `[[name]]`
   * - `composes`: agent → skill, one per agent's `skills[]` entry
   * - `step`: workflow → skill OR workflow → workflow, one per workflow's `steps[]` entry
   */
  kind: 'uses' | 'link' | 'composes' | 'step'
}

export interface Diagnostic {
  path: string
  severity: 'error' | 'warn'
  message: string
}

export interface KbGraph {
  nodes: SkillNode[]
  edges: SkillEdge[]
  diagnostics: Diagnostic[]
}

export type KbEventKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'

export interface KbEvent {
  kind: KbEventKind
  /** Absolute path on disk. */
  path: string
  /**
   * Entity name extracted from path when the path looks like
   *   <kbRoot>/<subdir>/<name>/...   (skills/agents/workflows)
   *   <kbRoot>/<subdir>/<name>.md    (memory)
   * else null. The `subdir` is one of skills/agents/workflows/memory.
   */
  skill: string | null
  ts: number
}
