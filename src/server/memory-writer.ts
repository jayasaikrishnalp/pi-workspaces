import fs from 'node:fs/promises'
import path from 'node:path'

export const MEMORY_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/
export const MEMORY_MAX_CHARS = 65_536

export type MemoryErrorCode =
  | 'INVALID_MEMORY_NAME'
  | 'BODY_TOO_LARGE'
  | 'UNKNOWN_MEMORY'
  | 'INTERNAL'

export class MemoryError extends Error {
  readonly code: MemoryErrorCode
  constructor(code: MemoryErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface MemoryEntry {
  name: string
  size: number
  mtime: number
}

function checkName(name: string): void {
  if (!MEMORY_NAME_RE.test(name)) {
    throw new MemoryError('INVALID_MEMORY_NAME', `name must match ${MEMORY_NAME_RE}; got ${JSON.stringify(name)}`)
  }
}

export async function listMemory(kbRoot: string): Promise<MemoryEntry[]> {
  const dir = path.join(kbRoot, 'memory')
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw err
  }
  const out: MemoryEntry[] = []
  for (const e of entries) {
    if (!e.endsWith('.md')) continue
    const name = e.slice(0, -3)
    if (!MEMORY_NAME_RE.test(name)) continue
    try {
      const stat = await fs.stat(path.join(dir, e))
      if (stat.isFile()) out.push({ name, size: stat.size, mtime: stat.mtimeMs })
    } catch {
      // skip
    }
  }
  // Most recent first.
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

export async function readMemory(kbRoot: string, name: string): Promise<{ name: string; body: string; size: number; mtime: number }> {
  checkName(name)
  const abs = path.join(kbRoot, 'memory', `${name}.md`)
  let body: string
  let stat
  try {
    body = await fs.readFile(abs, 'utf8')
    stat = await fs.stat(abs)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new MemoryError('UNKNOWN_MEMORY', `memory ${name} does not exist`)
    }
    throw new MemoryError('INTERNAL', `read failed: ${(err as Error).message}`)
  }
  return { name, body, size: stat.size, mtime: stat.mtimeMs }
}

/**
 * Upsert: creates if missing, replaces if present. Atomic via tmp + rename.
 * Returns post-write metadata.
 */
export async function writeMemory(kbRoot: string, name: string, content: string): Promise<MemoryEntry> {
  checkName(name)
  if (typeof content !== 'string') {
    throw new MemoryError('INTERNAL', 'content must be a string')
  }
  if (content.length > MEMORY_MAX_CHARS) {
    throw new MemoryError('BODY_TOO_LARGE', `content exceeds ${MEMORY_MAX_CHARS} characters`)
  }
  const dir = path.join(kbRoot, 'memory')
  await fs.mkdir(dir, { recursive: true })
  const abs = path.join(dir, `${name}.md`)
  const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`
  try {
    await fs.writeFile(tmp, content)
    await fs.rename(tmp, abs)
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined)
    throw new MemoryError('INTERNAL', `write failed: ${(err as Error).message}`)
  }
  const stat = await fs.stat(abs)
  return { name, size: stat.size, mtime: stat.mtimeMs }
}
