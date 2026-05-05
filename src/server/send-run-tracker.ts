/**
 * Per-session active-run slot. Synchronous (Node is single-threaded for JS),
 * so two POSTs cannot both pass `start()` for the same sessionKey. State is
 * in-memory only — a workspace restart loses active runs (which is correct
 * because the pi child died with it).
 */

export class SendRunTracker {
  private active = new Map<string, string>() // sessionKey -> runId

  /**
   * Reserve the active-run slot for a session. Throws ACTIVE_RUN if taken.
   * Returns the runId on success.
   */
  start(sessionKey: string, runId: string): void {
    const existing = this.active.get(sessionKey)
    if (existing) {
      const err = new Error(`ACTIVE_RUN: session ${sessionKey} already running ${existing}`)
      ;(err as Error & { code?: string; activeRunId?: string }).code = 'ACTIVE_RUN'
      ;(err as Error & { code?: string; activeRunId?: string }).activeRunId = existing
      throw err
    }
    this.active.set(sessionKey, runId)
  }

  /**
   * Clear the active-run slot. Idempotent. Only clears if the slot still
   * matches the runId that was started — if a different runId is now active
   * (which shouldn't happen in MVP) we leave it alone.
   */
  finish(sessionKey: string, runId: string): void {
    const existing = this.active.get(sessionKey)
    if (existing === runId) this.active.delete(sessionKey)
  }

  getActive(sessionKey: string): string | null {
    return this.active.get(sessionKey) ?? null
  }

  /** Used by bridge crash handler. */
  finishAll(): string[] {
    const cleared: string[] = []
    for (const [, runId] of this.active) cleared.push(runId)
    this.active.clear()
    return cleared
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __sendRunTracker: SendRunTracker | undefined
}

export function getSendRunTracker(): SendRunTracker {
  if (!globalThis.__sendRunTracker) globalThis.__sendRunTracker = new SendRunTracker()
  return globalThis.__sendRunTracker
}
