import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { jsonOk } from '../server/http-helpers.js'
import { buildGraph } from '../server/kb-browser.js'
import { listKbEntities } from '../server/kb-writer.js'
import { listMemory } from '../server/memory-writer.js'
import { ProvidersClient } from '../server/providers-client.js'
import { JobsStore } from '../server/jobs-store.js'
import { TasksStore } from '../server/tasks-store.js'
import { TerminalStore } from '../server/terminal-store.js'
import { getSchemaVersion } from '../server/db.js'
import type { Wiring } from '../server/wiring.js'

export const PROBE_PATH = '/api/probe'

const PI_VERSION_TIMEOUT_MS = 3_000
const PI_VERSION_RE = /^(\d+\.\d+\.\d+)/

interface PiResult {
  ok: boolean
  version?: string
  latencyMs?: number
  error?: string
  activeProvider?: string | null
  activeModel?: string | null
}

async function probePi(w: Wiring): Promise<PiResult> {
  const t0 = Date.now()
  let child
  try {
    child = w.spawnPi(['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    return { ok: false, error: `spawn failed: ${(err as Error).message}` }
  }
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (d) => { stdout += String(d) })
  // pi v0.73 writes the version banner to stderr (verified live with
  // `pi --version 1>/tmp/out 2>/tmp/err` on the operator's machine).
  // We accept either stream — match against the combined output.
  child.stderr?.on('data', (d) => { stderr += String(d) })

  const exitPromise = new Promise<{ code: number | null }>((resolve, reject) => {
    child.once('exit', (code) => resolve({ code }))
    child.once('error', (err) => reject(err))
  })
  const timer = setTimeout(() => {
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 200).unref()
  }, PI_VERSION_TIMEOUT_MS)
  timer.unref()

  try {
    const { code } = await exitPromise
    clearTimeout(timer)
    if (code !== 0) {
      return { ok: false, error: `pi --version exited code=${code}` }
    }
    // Try stdout first (some pi forks), fall back to stderr (v0.73 default).
    const combined = `${stdout}\n${stderr}`.trim()
    const m = PI_VERSION_RE.exec(combined)
    if (!m) {
      return { ok: false, error: `unparseable output: ${combined.slice(0, 100)}` }
    }
    return { ok: true, version: m[1], latencyMs: Date.now() - t0 }
  } catch (err) {
    clearTimeout(timer)
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { ok: false, error: `pi binary not found on PATH (ENOENT)` }
    if (Date.now() - t0 >= PI_VERSION_TIMEOUT_MS) {
      return { ok: false, error: `pi --version timed out after ${PI_VERSION_TIMEOUT_MS}ms` }
    }
    return { ok: false, error: e.message }
  }
}

export async function handleProbe(
  _req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  const piAuthJsonPath = path.join(os.homedir(), '.pi', 'agent', 'auth.json')
  const piAuthJsonPresent = await fs.access(piAuthJsonPath).then(() => true).catch(() => false)

  // Real pi probe via spawn.
  const pi = await probePi(w)

  // Active model from pi settings (best-effort).
  try {
    const active = await new ProvidersClient().getActive()
    pi.activeProvider = active.providerId
    pi.activeModel = active.modelId
  } catch {
    pi.activeProvider = null
    pi.activeModel = null
  }

  const confluenceConfigured = !!w.confluenceConfigured && !!w.confluence
  const confluenceError = w.confluenceConfigError

  // Counts.
  let skillsCount = 0
  try {
    skillsCount = (await buildGraph(w.kbRoot)).nodes.filter((n) => n.source === 'skill').length
  } catch { /* ignore */ }
  const [agentsCount, workflowsCount, memoryEntries, soulsCount] = await Promise.all([
    listKbEntities(w.kbRoot, 'agents').then((a) => a.length).catch(() => 0),
    listKbEntities(w.kbRoot, 'workflows').then((a) => a.length).catch(() => 0),
    listMemory(w.kbRoot).then((a) => a.length).catch(() => 0),
    listKbEntities(w.kbRoot, 'souls').then((a) => a.length).catch(() => 0),
  ])

  // SQLite + jobs + tasks (best-effort; absent in some test wirings).
  let dbInfo: { ok: boolean; schemaVersion?: number } = { ok: false }
  let jobsCount = 0
  let tasksCount = 0
  let tasksByStatus: Record<string, number> = {}
  let terminalCount = 0
  if (w.db) {
    try {
      const ver = getSchemaVersion(w.db)
      dbInfo = { ok: true, schemaVersion: ver }
      jobsCount = new JobsStore(w.db).totalCount()
      const tasks = new TasksStore(w.db)
      tasksCount = tasks.totalCount()
      tasksByStatus = tasks.countByStatus()
      terminalCount = new TerminalStore(w.db).totalCount()
    } catch {
      dbInfo = { ok: false }
    }
  }

  jsonOk(res, 200, {
    pi: {
      ok: pi.ok,
      ...(pi.version ? { version: pi.version } : {}),
      ...(typeof pi.latencyMs === 'number' ? { latencyMs: pi.latencyMs } : {}),
      ...(pi.error ? { error: pi.error } : {}),
      activeProvider: pi.activeProvider ?? null,
      activeModel: pi.activeModel ?? null,
    },
    confluence: {
      ok: confluenceConfigured,
      configured: confluenceConfigured,
      ...(confluenceError ? { error: confluenceError } : {}),
    },
    skills: { count: skillsCount },
    agents: { count: agentsCount },
    workflows: { count: workflowsCount },
    memory: { count: memoryEntries },
    souls: { count: soulsCount },
    jobs: { count: jobsCount },
    tasks: { count: tasksCount, byStatus: tasksByStatus },
    terminal: { count: terminalCount },
    db: dbInfo,
    mcp: { servers: w.mcpBroker?.getStatus?.() ?? [] },
    auth: { piAuthJsonPresent },
    wiki: w.wikiStore
      ? {
          configured: true,
          root: w.wikiRoot,
          count: w.wikiStore.count(),
          lastIngestAt: w.wikiStore.lastIngestAt(),
        }
      : { configured: false, count: 0, root: null, lastIngestAt: null },
    workspace: {
      kbRoot: w.kbRoot,
      skillsDir: w.skillsDir,
      runsDir: (w.runStore as { root: string }).root,
    },
  })
}
