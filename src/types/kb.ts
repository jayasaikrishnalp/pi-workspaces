export interface SkillNode {
  id: string
  name: string
  description?: string
  tags?: string[]
  /** Relative path from skillsDir (e.g. "reboot-server/SKILL.md"). */
  path: string
  source: 'skill'
}

export interface SkillEdge {
  source: string
  target: string
  kind: 'uses' | 'link'
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
  /** Skill name extracted from path if applicable, else null. */
  skill: string | null
  ts: number
}
