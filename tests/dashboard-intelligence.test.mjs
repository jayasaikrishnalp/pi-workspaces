/**
 * Dashboard intelligence aggregator tests. Seeds chat_messages with
 * deterministic rows and asserts each query returns expected shape +
 * values. Pure SQL — no event bus, no HTTP.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openDb } from '../src/server/db.ts'
import { buildIntelligence, STALE_DAYS, TOOL_HEAVY_THRESHOLD, HIGH_TOKEN_THRESHOLD } from '../src/server/dashboard-intelligence.ts'

function tmp() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-intel-')), 'data.sqlite')
}

function insertAssistant(db, opts) {
  db.prepare(`
    INSERT INTO chat_messages (id, run_id, session_id, role, content, tokens_in, tokens_out, cache_read, cache_write, cost_usd, model, provider, created_at)
    VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.id, opts.runId ?? 'r1', opts.sessionId, opts.content ?? 'ok',
    opts.tokensIn ?? 0, opts.tokensOut ?? 0, opts.cacheRead ?? 0, opts.cacheWrite ?? 0,
    opts.costUsd ?? 0, opts.model ?? 'claude-sonnet-4.6', opts.provider ?? 'anthropic',
    opts.createdAt,
  )
}

function insertTool(db, opts) {
  db.prepare(`
    INSERT INTO chat_messages (id, run_id, session_id, role, tool_name, created_at)
    VALUES (?, ?, ?, 'tool', ?, ?)
  `).run(opts.id, opts.runId ?? 'r1', opts.sessionId, opts.toolName, opts.createdAt)
}

const NOW = new Date('2026-05-06T12:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000

test('windowDays + sessionsCount + apiCallsCount', () => {
  const db = openDb(tmp())
  insertAssistant(db, { id: 'm1', sessionId: 'sess_1', createdAt: NOW - 1 * DAY, tokensIn: 100, tokensOut: 50 })
  insertAssistant(db, { id: 'm2', sessionId: 'sess_2', createdAt: NOW - 2 * DAY, tokensIn: 200 })
  insertAssistant(db, { id: 'm3', sessionId: 'sess_2', createdAt: NOW - 3 * DAY, tokensIn: 100 })
  insertAssistant(db, { id: 'm4', sessionId: 'sess_3', createdAt: NOW - 8 * DAY, tokensIn: 50 })  // outside 7d window
  const r = buildIntelligence(db, { now: NOW, windowDays: 7 })
  assert.equal(r.windowDays, 7)
  assert.equal(r.sessionsCount, 2, 'distinct sessions in window')
  assert.equal(r.apiCallsCount, 3, 'assistant calls in window')
  db.close()
})

test('tokenTotals + topModels', () => {
  const db = openDb(tmp())
  insertAssistant(db, { id: 'a1', sessionId: 's1', createdAt: NOW - 1 * DAY, tokensIn: 100, tokensOut: 50, cacheRead: 20, model: 'claude-opus-4.6', costUsd: 0.05 })
  insertAssistant(db, { id: 'a2', sessionId: 's1', createdAt: NOW - 1 * DAY, tokensIn: 80, tokensOut: 40, cacheRead: 30, model: 'claude-opus-4.6', costUsd: 0.04 })
  insertAssistant(db, { id: 'a3', sessionId: 's2', createdAt: NOW - 2 * DAY, tokensIn: 200, tokensOut: 100, model: 'gpt-4.1', costUsd: 0.20 })
  const r = buildIntelligence(db, { now: NOW, windowDays: 7 })
  assert.equal(r.tokenTotals.input, 100 + 80 + 200)
  assert.equal(r.tokenTotals.output, 50 + 40 + 100)
  assert.equal(r.tokenTotals.cacheRead, 20 + 30)
  assert.equal(r.topModels[0].model, 'claude-opus-4.6')
  assert.equal(r.topModels[0].sessions, 1)
  assert.ok(Math.abs(r.topModels[0].costUsd - 0.09) < 1e-9)
  db.close()
})

test('cacheContribution: 0 when no rows; correct ratio when rows present', () => {
  const db = openDb(tmp())
  let r = buildIntelligence(db, { now: NOW, windowDays: 7 })
  assert.equal(r.cacheContribution, 0)

  insertAssistant(db, { id: 'c1', sessionId: 'cs', createdAt: NOW - DAY, cacheRead: 900, cacheWrite: 10, tokensIn: 90 })
  r = buildIntelligence(db, { now: NOW, windowDays: 7 })
  assert.ok(Math.abs(r.cacheContribution - 0.9) < 1e-9, `expected ~0.9, got ${r.cacheContribution}`)
  db.close()
})

test('sessionsIntelligence tags: TOOL_HEAVY + HIGH_TOKEN + STALE', () => {
  const db = openDb(tmp())
  // TOOL_HEAVY session — > THRESHOLD tools
  insertAssistant(db, { id: 'tha1', sessionId: 'tool_heavy', createdAt: NOW - DAY, tokensIn: 10 })
  for (let i = 0; i < TOOL_HEAVY_THRESHOLD + 1; i++) {
    insertTool(db, { id: `t${i}`, sessionId: 'tool_heavy', toolName: `tool-${i % 3}`, createdAt: NOW - DAY })
  }

  // HIGH_TOKEN session — > THRESHOLD tokens
  insertAssistant(db, { id: 'hta1', sessionId: 'high_token', createdAt: NOW - DAY, tokensIn: HIGH_TOKEN_THRESHOLD + 1, tokensOut: 100 })

  // STALE session — last activity > STALE_DAYS+ ago.  We need it inside the
  // query window (use 30d), but old enough to be stale.
  insertAssistant(db, { id: 'sta1', sessionId: 'stale_one', createdAt: NOW - (STALE_DAYS + 2) * DAY, tokensIn: 10 })

  const r = buildIntelligence(db, { now: NOW, windowDays: 30 })
  const map = new Map(r.sessionsIntelligence.map((e) => [e.sessionId, e]))

  assert.ok(map.get('tool_heavy').tags.includes('TOOL_HEAVY'))
  assert.ok(map.get('high_token').tags.includes('HIGH_TOKEN'))
  assert.ok(map.get('stale_one').tags.includes('STALE'))
  db.close()
})

test('hourOfDayHistogram returns all 24 hours', () => {
  const db = openDb(tmp())
  insertAssistant(db, { id: 'h1', sessionId: 's1', createdAt: NOW - DAY, tokensIn: 5 })
  const r = buildIntelligence(db, { now: NOW, windowDays: 7 })
  assert.equal(r.hourOfDayHistogram.length, 24)
  for (let h = 0; h < 24; h++) assert.equal(r.hourOfDayHistogram[h].hourUtc, h)
  // The single row should land in exactly one hour bucket.
  const total = r.hourOfDayHistogram.reduce((s, x) => s + x.count, 0)
  assert.equal(total, 1)
  db.close()
})

test('topTools: ranks by count desc', () => {
  const db = openDb(tmp())
  for (let i = 0; i < 5; i++) insertTool(db, { id: `t-a-${i}`, sessionId: 's', toolName: 'alpha', createdAt: NOW - DAY })
  for (let i = 0; i < 3; i++) insertTool(db, { id: `t-b-${i}`, sessionId: 's', toolName: 'beta',  createdAt: NOW - DAY })
  const r = buildIntelligence(db, { now: NOW, windowDays: 7 })
  assert.equal(r.topTools[0].tool, 'alpha')
  assert.equal(r.topTools[0].count, 5)
  assert.equal(r.topTools[1].tool, 'beta')
  assert.equal(r.topTools[1].count, 3)
  db.close()
})

test('activeModel returns the most recent model', () => {
  const db = openDb(tmp())
  insertAssistant(db, { id: 'm-old', sessionId: 's', createdAt: NOW - 5 * DAY, model: 'claude-opus-4.6' })
  insertAssistant(db, { id: 'm-new', sessionId: 's', createdAt: NOW - DAY,     model: 'claude-sonnet-4.6' })
  const r = buildIntelligence(db, { now: NOW, windowDays: 7 })
  assert.equal(r.activeModel, 'claude-sonnet-4.6')
  db.close()
})
