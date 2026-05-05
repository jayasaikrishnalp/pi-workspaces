import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import type { NormalizedEvent } from '../events/types.js'
import type { EnrichedEvent, RunMeta, RunStatus } from '../types/run.js'

const DEFAULT_ROOT = path.join(os.homedir(), '.pi-workspace')

export interface RunStoreOptions {
  root?: string
}

interface RunInternals {
  runId: string
  dir: string
  metaPath: string
  eventsPath: string
  seqPath: string
  // last assigned seq; -1 means uninitialized; 0 means no events yet
  seq: number
  writeChain: Promise<unknown>
  metaCached: RunMeta | null
}

export class RunStore {
  readonly root: string
  private runs = new Map<string, RunInternals>()

  constructor(options: RunStoreOptions = {}) {
    this.root = options.root ?? path.join(DEFAULT_ROOT, 'runs')
    fssync.mkdirSync(this.root, { recursive: true })
  }

  private internals(runId: string): RunInternals {
    let r = this.runs.get(runId)
    if (r) return r
    const dir = path.join(this.root, runId)
    r = {
      runId,
      dir,
      metaPath: path.join(dir, 'meta.json'),
      eventsPath: path.join(dir, 'events.jsonl'),
      seqPath: path.join(dir, 'seq.txt'),
      seq: -1,
      writeChain: Promise.resolve(),
      metaCached: null,
    }
    this.runs.set(runId, r)
    return r
  }

  /** Create the run on disk: directory + meta.json. Idempotent. */
  async startRun(meta: Omit<RunMeta, 'status' | 'startedAt'>): Promise<RunMeta> {
    const r = this.internals(meta.runId)
    await fs.mkdir(r.dir, { recursive: true })
    const full: RunMeta = {
      ...meta,
      status: 'running',
      startedAt: Date.now(),
    }
    await this.writeMetaAtomic(r, full)
    r.metaCached = full
    r.seq = 0
    await fs.writeFile(r.seqPath, '0')
    return full
  }

  /**
   * Append a normalized event. Assigns seq + eventId, writes events.jsonl
   * (then seq.txt) before resolving. Per-run write chain serializes calls
   * for the same runId so seq is always monotonic with no gaps.
   *
   * Crash safety: r.seq is updated AFTER events.jsonl is appended (so a stale
   * value cannot reuse a seq). seq.txt is best-effort; rebuild logic in
   * loadSeqFromDisk takes max(seq.txt, last seq in events.jsonl).
   */
  async appendNormalized(
    runId: string,
    sessionKey: string,
    raw: NormalizedEvent,
  ): Promise<EnrichedEvent> {
    const r = this.internals(runId)
    const next = r.writeChain.then(async () => {
      if (r.seq < 0) await this.loadSeqFromDisk(r)
      const seq = r.seq + 1
      const eventId = `${runId}:${seq}`
      const enriched: EnrichedEvent = {
        ...raw,
        meta: { runId, sessionKey, seq, eventId },
      }
      await fs.appendFile(r.eventsPath, JSON.stringify(enriched) + '\n')
      // Bump in-memory seq the moment events.jsonl is durable, BEFORE the
      // (best-effort) seq.txt write. If seq.txt fails the next append still
      // uses seq+1.
      r.seq = seq
      try {
        await fs.writeFile(r.seqPath, String(seq))
      } catch (err) {
        // seq.txt is a startup hint; ignore failures here.
        console.error('[run-store] seq.txt write failed (non-fatal):', err)
      }
      return enriched
    })
    r.writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** Read events from disk filtered by seq > afterSeq (default 0 = all). */
  async getEvents(
    runId: string,
    options: { afterSeq?: number } = {},
  ): Promise<EnrichedEvent[]> {
    const r = this.internals(runId)
    let raw: string
    try {
      raw = await fs.readFile(r.eventsPath, 'utf8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return []
      throw err
    }
    const lines = raw.split('\n').filter((l) => l.length > 0)
    const out: EnrichedEvent[] = []
    const after = options.afterSeq ?? 0
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as EnrichedEvent
        if (e.meta?.seq != null && e.meta.seq > after) out.push(e)
      } catch {
        // skip corrupt lines but keep going
      }
    }
    out.sort((a, b) => a.meta.seq - b.meta.seq)
    return out
  }

  async getMeta(runId: string): Promise<RunMeta | null> {
    const r = this.internals(runId)
    if (r.metaCached) return r.metaCached
    try {
      const raw = await fs.readFile(r.metaPath, 'utf8')
      const meta = JSON.parse(raw) as RunMeta
      r.metaCached = meta
      return meta
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw err
    }
  }

  async getStatus(runId: string): Promise<RunStatus | null> {
    const meta = await this.getMeta(runId)
    return meta?.status ?? null
  }

  /**
   * CAS status. Returns true if the transition happened, false if expected
   * mismatched. Joins the per-run write chain so it cannot interleave with
   * appendNormalized for the same runId.
   */
  async casStatus(
    runId: string,
    expected: RunStatus | RunStatus[],
    nextStatus: RunStatus,
    extra: Partial<Pick<RunMeta, 'finishedAt' | 'error'>> = {},
  ): Promise<boolean> {
    const r = this.internals(runId)
    const next = r.writeChain.then(async () => {
      const meta = await this.getMeta(runId)
      if (!meta) return false
      const allowed = Array.isArray(expected) ? expected : [expected]
      if (!allowed.includes(meta.status)) return false
      const updated: RunMeta = {
        ...meta,
        status: nextStatus,
        finishedAt: extra.finishedAt ?? meta.finishedAt,
        error: extra.error ?? meta.error,
      }
      await this.writeMetaAtomic(r, updated)
      r.metaCached = updated
      return true
    })
    r.writeChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async writeMetaAtomic(r: RunInternals, meta: RunMeta) {
    const tmp = `${r.metaPath}.tmp.${process.pid}.${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2))
    await fs.rename(tmp, r.metaPath)
  }

  private async loadSeqFromDisk(r: RunInternals) {
    let fromHint = 0
    try {
      const raw = await fs.readFile(r.seqPath, 'utf8')
      fromHint = Number(raw.trim()) || 0
    } catch {
      fromHint = 0
    }
    let fromLog = 0
    try {
      const raw = await fs.readFile(r.eventsPath, 'utf8')
      const lines = raw.split('\n').filter((l) => l.length > 0)
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as { meta?: { seq?: number } }
          const s = e?.meta?.seq
          if (typeof s === 'number' && s > fromLog) fromLog = s
        } catch {
          // skip corrupt lines
        }
      }
    } catch {
      // events.jsonl missing — fromLog stays 0
    }
    r.seq = Math.max(fromHint, fromLog)
  }
}
