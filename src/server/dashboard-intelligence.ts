import type { Db } from './db.js'
import type {
  DashboardIntelligence, ModelEntry, SessionIntelEntry, SessionIntelTags,
  ToolEntry, UsageTrendPoint,
} from '../types/dashboard.js'

// Tunable thresholds for sessionsIntelligence tags. Constants surfaced here so
// they can be adjusted without code spelunking; spec'd in
// openspec/specs/session-intelligence.
export const STALE_DAYS = 7
export const STALE_INACTIVE_HOURS = 48
export const TOOL_HEAVY_THRESHOLD = 20
export const HIGH_TOKEN_THRESHOLD = 100_000

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

interface BuildOpts { now?: number; windowDays: number }

export function buildIntelligence(db: Db, opts: BuildOpts): DashboardIntelligence {
  const now = opts.now ?? Date.now()
  const since = now - opts.windowDays * DAY_MS

  return {
    windowDays: opts.windowDays,
    sessionsCount: countSessions(db, since),
    apiCallsCount: countAssistantCalls(db, since),
    tokenTotals: tokenTotals(db, since),
    topModels: topModels(db, since, 5),
    cacheContribution: cacheContribution(db, since),
    usageTrend: usageTrend(db, since),
    sessionsIntelligence: sessionsIntelligence(db, since, now, 20),
    hourOfDayHistogram: hourOfDayHistogram(db, since),
    tokenMix: tokenMix(db, since),
    topTools: topTools(db, since, 10),
    activeModel: latestActiveModel(db, since),
  }
}

function countSessions(db: Db, since: number): number {
  const r = db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS c FROM chat_messages
    WHERE role = 'assistant' AND created_at >= ? AND session_id IS NOT NULL
  `).get(since) as { c: number }
  return r.c
}

function countAssistantCalls(db: Db, since: number): number {
  const r = db.prepare(`
    SELECT COUNT(*) AS c FROM chat_messages
    WHERE role = 'assistant' AND created_at >= ?
  `).get(since) as { c: number }
  return r.c
}

function tokenTotals(db: Db, since: number) {
  const r = db.prepare(`
    SELECT
      COALESCE(SUM(tokens_in),  0) AS input,
      COALESCE(SUM(tokens_out), 0) AS output,
      COALESCE(SUM(cache_read), 0) AS cacheRead,
      COALESCE(SUM(cache_write),0) AS cacheWrite
    FROM chat_messages
    WHERE role = 'assistant' AND created_at >= ?
  `).get(since) as { input: number; output: number; cacheRead: number; cacheWrite: number }
  return r
}

function topModels(db: Db, since: number, limit: number): ModelEntry[] {
  return db.prepare(`
    SELECT model AS model,
           COALESCE(SUM(tokens_in + tokens_out + cache_read), 0) AS tokens,
           COUNT(DISTINCT session_id) AS sessions,
           COALESCE(SUM(cost_usd), 0) AS costUsd
    FROM chat_messages
    WHERE role = 'assistant' AND created_at >= ? AND model IS NOT NULL
    GROUP BY model
    ORDER BY tokens DESC
    LIMIT ?
  `).all(since, limit) as ModelEntry[]
}

function cacheContribution(db: Db, since: number): number {
  const r = db.prepare(`
    SELECT
      COALESCE(SUM(cache_read), 0)  AS cr,
      COALESCE(SUM(cache_write), 0) AS cw,
      COALESCE(SUM(tokens_in), 0)   AS ti
    FROM chat_messages
    WHERE role = 'assistant' AND created_at >= ?
  `).get(since) as { cr: number; cw: number; ti: number }
  const denom = r.cr + r.cw + r.ti
  return denom === 0 ? 0 : r.cr / denom
}

function usageTrend(db: Db, since: number): UsageTrendPoint[] {
  // Group by UTC day.
  const buckets = db.prepare(`
    SELECT date(created_at / 1000, 'unixepoch') AS bucket,
           COALESCE(SUM(tokens_in + tokens_out), 0) AS tokensTotal,
           COALESCE(SUM(cache_read), 0)             AS cacheRead,
           COALESCE(SUM(cost_usd), 0)               AS cost
    FROM chat_messages
    WHERE role = 'assistant' AND created_at >= ?
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(since) as Array<{ bucket: string; tokensTotal: number; cacheRead: number; cost: number }>

  const topTool = db.prepare(`
    SELECT date(created_at / 1000, 'unixepoch') AS bucket, tool_name, COUNT(*) AS c
    FROM chat_messages
    WHERE role = 'tool' AND created_at >= ? AND tool_name IS NOT NULL
    GROUP BY bucket, tool_name
    ORDER BY bucket ASC, c DESC
  `).all(since) as Array<{ bucket: string; tool_name: string; c: number }>

  const topByBucket = new Map<string, string>()
  for (const row of topTool) {
    if (!topByBucket.has(row.bucket)) topByBucket.set(row.bucket, row.tool_name)
  }
  return buckets.map((b) => ({ ...b, topTool: topByBucket.get(b.bucket) ?? null }))
}

function sessionsIntelligence(db: Db, since: number, now: number, limit: number): SessionIntelEntry[] {
  const rows = db.prepare(`
    SELECT
      session_id AS sessionId,
      COUNT(*) FILTER (WHERE role IN ('assistant','user')) AS msgCount,
      COUNT(*) FILTER (WHERE role = 'tool')                AS toolCount,
      COALESCE(SUM(tokens_in + tokens_out + cache_read), 0) AS tokensTotal,
      COALESCE(SUM(cost_usd), 0)                            AS costUsd,
      MAX(created_at) AS lastActivityAt
    FROM chat_messages
    WHERE created_at >= ? AND session_id IS NOT NULL
    GROUP BY session_id
    ORDER BY lastActivityAt DESC
    LIMIT ?
  `).all(since, limit) as Array<{
    sessionId: string; msgCount: number; toolCount: number; tokensTotal: number;
    costUsd: number; lastActivityAt: number;
  }>

  const titleStmt = db.prepare(`SELECT title FROM session_titles WHERE session_id = ?`)
  const firstUserStmt = db.prepare(`
    SELECT content FROM chat_messages
    WHERE session_id = ? AND role = 'user' AND content IS NOT NULL AND length(content) > 0
    ORDER BY created_at ASC LIMIT 1
  `)
  const predominantModelStmt = db.prepare(`
    SELECT model, COUNT(*) AS c FROM chat_messages
    WHERE session_id = ? AND model IS NOT NULL
    GROUP BY model ORDER BY c DESC LIMIT 1
  `)

  return rows.map<SessionIntelEntry>((r) => {
    const last = r.lastActivityAt
    const ageMs = now - last
    const tags: Array<keyof SessionIntelTags> = []
    if (ageMs > STALE_DAYS * DAY_MS && ageMs > STALE_INACTIVE_HOURS * HOUR_MS) tags.push('STALE')
    if (r.toolCount > TOOL_HEAVY_THRESHOLD) tags.push('TOOL_HEAVY')
    if (r.tokensTotal > HIGH_TOKEN_THRESHOLD) tags.push('HIGH_TOKEN')

    const titled = titleStmt.get(r.sessionId) as { title: string } | undefined
    let title = titled?.title
    if (!title) {
      const firstUser = firstUserStmt.get(r.sessionId) as { content: string } | undefined
      title = firstUser?.content ? firstUser.content.slice(0, 60) : `(empty session ${r.sessionId.slice(-6)})`
    }
    const model = predominantModelStmt.get(r.sessionId) as { model: string; c: number } | undefined

    return {
      sessionId: r.sessionId,
      title,
      msgCount: r.msgCount,
      toolCount: r.toolCount,
      tokensTotal: r.tokensTotal,
      costUsd: r.costUsd,
      predominantModel: model?.model ?? null,
      lastActivityAt: last,
      agoText: agoText(ageMs),
      tags,
    }
  })
}

function hourOfDayHistogram(db: Db, since: number) {
  const rows = db.prepare(`
    SELECT CAST(strftime('%H', created_at / 1000, 'unixepoch') AS INTEGER) AS hourUtc,
           COUNT(*) AS count,
           COALESCE(SUM(tokens_in + tokens_out + cache_read), 0) AS tokens
    FROM chat_messages
    WHERE role = 'assistant' AND created_at >= ?
    GROUP BY hourUtc
    ORDER BY hourUtc ASC
  `).all(since) as Array<{ hourUtc: number; count: number; tokens: number }>
  // Always return all 24 hours so the chart axis is stable.
  const map = new Map(rows.map((r) => [r.hourUtc, r]))
  const out: Array<{ hourUtc: number; count: number; tokens: number }> = []
  for (let h = 0; h < 24; h++) {
    out.push(map.get(h) ?? { hourUtc: h, count: 0, tokens: 0 })
  }
  return out
}

function tokenMix(db: Db, since: number) {
  return tokenTotals(db, since)
}

function topTools(db: Db, since: number, limit: number): ToolEntry[] {
  return db.prepare(`
    SELECT tool_name AS tool, COUNT(*) AS count FROM chat_messages
    WHERE role = 'tool' AND created_at >= ? AND tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY count DESC
    LIMIT ?
  `).all(since, limit) as ToolEntry[]
}

function latestActiveModel(db: Db, since: number): string | null {
  const r = db.prepare(`
    SELECT model FROM chat_messages
    WHERE role = 'assistant' AND model IS NOT NULL AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1
  `).get(since) as { model: string } | undefined
  return r?.model ?? null
}

function agoText(ms: number): string {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}
