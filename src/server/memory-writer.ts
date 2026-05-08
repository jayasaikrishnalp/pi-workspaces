import fs from 'node:fs/promises'
import path from 'node:path'

export const MEMORY_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/
export const MEMORY_MAX_CHARS = 65_536

export type MemoryErrorCode =
  | 'INVALID_MEMORY_NAME'
  | 'BODY_TOO_LARGE'
  | 'UNKNOWN_MEMORY'
  | 'MEMORY_BLOCKED'
  | 'INTERNAL'

export class MemoryError extends Error {
  readonly code: MemoryErrorCode
  constructor(code: MemoryErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/**
 * Patterns that block a memory write because they look like prompt-injection
 * or exfiltration payloads. Ported from hermes-agent's
 * tools/memory_tool.py:_MEMORY_THREAT_PATTERNS. Memory is destined to be
 * injected back into pi's system prompt (via the future frozen-snapshot
 * flow), so anything that would re-write pi's instructions must be refused
 * at write time.
 *
 * The list is intentionally broad — false positives are recoverable (the
 * agent can rephrase), false negatives are not.
 */
const MEMORY_THREAT_PATTERNS: Array<[RegExp, string]> = [
  // Prompt injection
  [/\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?/i, 'prompt-injection-ignore-prev'],
  [/\b(?:you\s+are|act\s+as|pretend\s+to\s+be)\s+(?:now\s+)?(?:a\s+)?[a-z][a-z0-9 _-]{0,40}\s+(?:agent|assistant|model|system)/i, 'prompt-injection-role-hijack'],
  [/\bdisregard\s+(?:any\s+)?(?:earlier|prior|previous)\s+(?:instructions|directives|rules)/i, 'prompt-injection-disregard'],
  [/\bsystem\s*[:\-]\s*(?:you\s+are|new\s+instructions?)/i, 'prompt-injection-fake-system'],
  // Credential exfiltration
  [/curl[^\n]*\.env\b/i, 'exfil-curl-env'],
  [/curl[^\n]*\.aws\/credentials/i, 'exfil-curl-aws'],
  [/wget[^\n]*\.env\b/i, 'exfil-wget-env'],
  [/cat\s+~?\/?\.aws\/credentials/i, 'exfil-cat-aws'],
  [/cat\s+~?\/?\.ssh\/id_(?:rsa|ed25519|ecdsa)/i, 'exfil-cat-sshkey'],
  // SSH backdoor
  [/echo\s+["'][^"']+["']\s*>>\s*~?\/?\.ssh\/authorized_keys/i, 'backdoor-ssh-authorized-keys'],
]

const INVISIBLE_CHARS: number[] = [
  0x200B, // zero-width space
  0x200C, // zero-width non-joiner
  0x200D, // zero-width joiner
  0x2060, // word joiner
  0xFEFF, // BOM / zero-width no-break space
  0x2028, // line separator
  0x2029, // paragraph separator
]

/**
 * Scan content for prompt-injection / exfiltration / role-hijack patterns and
 * invisible unicode. Returns null on accept, or a human-readable error string
 * on reject (the matched pattern's id is included so the caller can iterate).
 */
export function scanMemoryThreats(content: string): string | null {
  for (const code of INVISIBLE_CHARS) {
    if (content.includes(String.fromCharCode(code))) {
      return `content contains invisible unicode U+${code.toString(16).toUpperCase().padStart(4, '0')} — refused`
    }
  }
  for (const [pattern, id] of MEMORY_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      return `content matches threat pattern "${id}" — refused (mentions instruction override, role-hijack, or credential exfiltration)`
    }
  }
  return null
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
 * Runs threat scan before persistence — memory content is destined to flow
 * into pi's system prompt, so an `ignore previous instructions` payload
 * round-tripping through memory would be an injection. Returns post-write
 * metadata. Pass `{ skipScan: true }` only for trusted callers (tests).
 */
export async function writeMemory(
  kbRoot: string,
  name: string,
  content: string,
  opts: { skipScan?: boolean } = {},
): Promise<MemoryEntry> {
  checkName(name)
  if (typeof content !== 'string') {
    throw new MemoryError('INTERNAL', 'content must be a string')
  }
  if (content.length > MEMORY_MAX_CHARS) {
    throw new MemoryError('BODY_TOO_LARGE', `content exceeds ${MEMORY_MAX_CHARS} characters`)
  }
  if (!opts.skipScan) {
    const threat = scanMemoryThreats(content)
    if (threat) throw new MemoryError('MEMORY_BLOCKED', threat)
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

/**
 * Delete a memory entry. Returns true on delete, false when the entry was
 * already absent. Anything else throws MemoryError.
 */
export async function deleteMemory(kbRoot: string, name: string): Promise<boolean> {
  checkName(name)
  const abs = path.join(kbRoot, 'memory', `${name}.md`)
  try {
    await fs.unlink(abs)
    return true
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false
    throw new MemoryError('INTERNAL', `delete failed: ${(err as Error).message}`)
  }
}
