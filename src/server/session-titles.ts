import type { Db } from './db.js'

const MAX_TITLE_LEN = 200
const AUTO_TITLE_LEN = 60

/**
 * Get the current title for a session, if any.
 */
export function getSessionTitle(db: Db, sessionId: string): string | undefined {
  const row = db
    .prepare(`SELECT title FROM session_titles WHERE session_id = ?`)
    .get(sessionId) as { title?: string } | undefined
  const t = row?.title?.trim()
  return t && t.length > 0 ? t : undefined
}

/**
 * Set or clear the title for a session. An empty/whitespace title clears.
 * Trims input. Throws on titles longer than MAX_TITLE_LEN.
 */
export function setSessionTitle(db: Db, sessionId: string, title: string): void {
  if (typeof title !== 'string') throw new Error('title must be a string')
  const trimmed = title.trim()
  if (trimmed.length > MAX_TITLE_LEN) throw new Error('title too long')
  if (trimmed.length === 0) {
    db.prepare(`DELETE FROM session_titles WHERE session_id = ?`).run(sessionId)
    return
  }
  db.prepare(`
    INSERT INTO session_titles (session_id, title, set_at) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, set_at = excluded.set_at
  `).run(sessionId, trimmed, Date.now())
}

/**
 * Seed a title from a prompt, but only if the session has none. Used by the
 * send-stream pipeline so the first user prompt becomes the displayed name
 * unless the user already overrode it.
 */
export function autoTitleIfMissing(db: Db, sessionId: string, prompt: string): void {
  if (getSessionTitle(db, sessionId)) return
  const cleaned = prompt
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return
  const truncated = cleaned.length > AUTO_TITLE_LEN
    ? cleaned.slice(0, AUTO_TITLE_LEN - 1).trimEnd() + '…'
    : cleaned
  setSessionTitle(db, sessionId, truncated)
}

export const TITLE_LIMITS = {
  MAX_TITLE_LEN,
  AUTO_TITLE_LEN,
}
