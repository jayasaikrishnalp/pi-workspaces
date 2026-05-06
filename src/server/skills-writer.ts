import fs from 'node:fs/promises'
import path from 'node:path'

export const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/
/**
 * Spec says "characters" — JS-string-length, not UTF-8 byte count. A multibyte
 * character is one unit of the cap. (kept the constant name as MAX_BODY_CHARS
 * for clarity.)
 */
export const MAX_BODY_CHARS = 32_768

/**
 * Shared error code set for skills/agents/workflows writers. Memory writer
 * has its own simpler error type since memory has no name regex / frontmatter
 * concerns.
 */
export type SkillWriteErrorCode =
  // Skill-specific (kept for back-compat)
  | 'INVALID_SKILL_NAME'
  | 'SKILL_EXISTS'
  | 'UNKNOWN_SKILL'
  // Agent-specific
  | 'INVALID_AGENT_NAME'
  | 'INVALID_AGENT_SKILLS'
  | 'AGENT_EXISTS'
  | 'UNKNOWN_AGENT'
  // Workflow-specific
  | 'INVALID_WORKFLOW_NAME'
  | 'INVALID_WORKFLOW_STEPS'
  | 'WORKFLOW_EXISTS'
  | 'UNKNOWN_WORKFLOW'
  // Shared
  | 'INVALID_FRONTMATTER'
  | 'BODY_TOO_LARGE'
  | 'INTERNAL'

export class SkillWriteError extends Error {
  readonly code: SkillWriteErrorCode
  constructor(code: SkillWriteErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface WriteSkillInput {
  name: string
  content?: string
  /** Object form of YAML frontmatter. Caller's `name` always wins. */
  frontmatter?: Record<string, unknown>
}

export interface WriteSkillResult {
  /** Path relative to skillsDir, e.g. "runbook-foo/SKILL.md". */
  relPath: string
  /** Path absolute on disk. */
  absPath: string
}

/**
 * Atomically write `<skillsDir>/<name>/SKILL.md`. Tmp + rename; the .tmp file
 * never survives a success.
 *
 * Concurrency: the skill directory itself is the reservation. We try
 * `mkdir(dir)` (non-recursive, fails with EEXIST if it already exists). If
 * EEXIST, we re-check whether SKILL.md is present:
 *   - present → SKILL_EXISTS
 *   - absent  → another caller is mid-write or left an empty dir; we still
 *     fail with SKILL_EXISTS rather than racing for the slot. Two concurrent
 *     POSTs for the same name therefore produce exactly one 201 and one 409.
 *
 * Note: this means an empty skill directory left over from a crash will
 * permanently block new creation under that name until removed. Acceptable
 * for MVP — the mismatched empty dir would have surfaced as a Stage 4
 * diagnostic anyway.
 */
export async function writeSkill(
  skillsDir: string,
  input: WriteSkillInput,
): Promise<WriteSkillResult> {
  if (!SKILL_NAME_RE.test(input.name)) {
    throw new SkillWriteError(
      'INVALID_SKILL_NAME',
      `name must match ${SKILL_NAME_RE}; got ${JSON.stringify(input.name)}`,
    )
  }
  const body = input.content ?? ''
  // String-length check, not byte-length: cap is in characters per spec.
  if (body.length > MAX_BODY_CHARS) {
    throw new SkillWriteError(
      'BODY_TOO_LARGE',
      `content exceeds ${MAX_BODY_CHARS} characters`,
    )
  }
  // Render frontmatter BEFORE creating the dir so a validation error doesn't
  // leave a stranded directory behind.
  const frontmatter = renderFrontmatter({ ...(input.frontmatter ?? {}), name: input.name })
  const fileText = `---\n${frontmatter}---\n${body}`

  const dir = path.join(skillsDir, input.name)
  const absPath = path.join(dir, 'SKILL.md')
  const tmpPath = `${absPath}.tmp.${process.pid}.${Date.now()}`

  // Ensure the parent skillsDir exists (recursive is fine here).
  await fs.mkdir(skillsDir, { recursive: true })

  // Atomic reservation: non-recursive mkdir fails with EEXIST if anyone else
  // already created this skill's directory. That guarantees only the first
  // caller proceeds.
  try {
    await fs.mkdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new SkillWriteError('SKILL_EXISTS', `skill ${input.name} already exists`)
    }
    throw new SkillWriteError('INTERNAL', `mkdir failed: ${(err as Error).message}`)
  }

  try {
    await fs.writeFile(tmpPath, fileText)
    await fs.rename(tmpPath, absPath)
  } catch (err) {
    // Best-effort cleanup on partial failure: drop the dir so the slot can be
    // retaken. (We only do this if no SKILL.md ended up on disk.)
    try {
      await fs.unlink(tmpPath).catch(() => undefined)
      const exists = await fs.stat(absPath).then(() => true).catch(() => false)
      if (!exists) await fs.rmdir(dir).catch(() => undefined)
    } catch {
      // ignore
    }
    throw new SkillWriteError('INTERNAL', `write failed: ${(err as Error).message}`)
  }

  // Sweep any stale tmp files left from prior crashes.
  try {
    const entries = await fs.readdir(dir)
    for (const e of entries) {
      if (e.startsWith('SKILL.md.tmp.') && e !== path.basename(tmpPath)) {
        await fs.unlink(path.join(dir, e)).catch(() => undefined)
      }
    }
  } catch {
    // ignore
  }

  return {
    relPath: `${input.name}/SKILL.md`,
    absPath,
  }
}

/**
 * Render a small object → YAML frontmatter using only the documented shapes:
 * scalar string and string array. Numbers, booleans, mixed arrays, and nested
 * objects are rejected with INVALID_FRONTMATTER (silent drops would hide
 * client bugs).
 */
export function renderFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = []
  const keys = Object.keys(fm)
  keys.sort((a, b) => (a === 'name' ? -1 : b === 'name' ? 1 : a.localeCompare(b)))
  for (const k of keys) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(k)) {
      throw new SkillWriteError('INVALID_FRONTMATTER', `frontmatter key "${k}" is not a valid identifier`)
    }
    const v = fm[k]
    if (v == null) continue
    if (typeof v === 'string') {
      lines.push(`${k}: ${escapeScalar(v)}`)
      continue
    }
    if (Array.isArray(v)) {
      // Reject mixed arrays — silent drops hide client bugs.
      if (!v.every((x) => typeof x === 'string')) {
        throw new SkillWriteError(
          'INVALID_FRONTMATTER',
          `frontmatter "${k}" array has non-string items; only string[] is accepted`,
        )
      }
      const items = v as string[]
      if (items.length === 0) {
        lines.push(`${k}: []`)
      } else {
        lines.push(`${k}:`)
        for (const it of items) {
          lines.push(`  - ${escapeScalar(it)}`)
        }
      }
      continue
    }
    throw new SkillWriteError(
      'INVALID_FRONTMATTER',
      `frontmatter "${k}" has unsupported type ${typeof v}; only string and string[] are accepted`,
    )
  }
  return lines.length === 0 ? '' : lines.join('\n') + '\n'
}

function escapeScalar(s: string): string {
  // Quote strings that contain YAML-significant characters.
  if (/[:#\n"'\[\]{},&*!|<>%@`]/.test(s)) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return s
}
