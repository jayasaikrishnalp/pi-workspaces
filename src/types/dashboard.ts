/**
 * Shared TypeScript contract for the /api/dashboard/intelligence response.
 * Imported by both the server (response builder) and the client (consumer)
 * so the shape can never drift.
 */

export interface SessionIntelTags {
  STALE: boolean
  TOOL_HEAVY: boolean
  HIGH_TOKEN: boolean
}

export interface SessionIntelEntry {
  sessionId: string
  title: string
  msgCount: number
  toolCount: number
  tokensTotal: number
  costUsd: number
  predominantModel: string | null
  lastActivityAt: number | null
  agoText: string
  tags: Array<keyof SessionIntelTags>
}

export interface ModelEntry {
  model: string
  tokens: number
  sessions: number
  costUsd: number
}

export interface ToolEntry { tool: string; count: number }

export interface UsageTrendPoint {
  bucket: string
  tokensTotal: number
  cacheRead: number
  cost: number
  topTool: string | null
}

export interface DashboardIntelligence {
  windowDays: number
  sessionsCount: number
  apiCallsCount: number
  tokenTotals: { input: number; output: number; cacheRead: number; cacheWrite: number }
  topModels: ModelEntry[]
  cacheContribution: number
  usageTrend: UsageTrendPoint[]
  sessionsIntelligence: SessionIntelEntry[]
  hourOfDayHistogram: Array<{ hourUtc: number; count: number; tokens: number }>
  tokenMix: { input: number; output: number; cacheRead: number; cacheWrite: number }
  topTools: ToolEntry[]
  activeModel: string | null
}
