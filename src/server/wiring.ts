import path from 'node:path'
import os from 'node:os'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

import { ChatEventBus, getChatEventBus } from './chat-event-bus.js'
import { RunStore } from './run-store.js'
import { SendRunTracker, getSendRunTracker } from './send-run-tracker.js'
import { PiRpcBridge, getPiRpcBridge } from './pi-rpc-bridge.js'
import { KbEventBus, getKbEventBus } from './kb-event-bus.js'
import { KbWatcher } from './kb-watcher.js'
import { ConfluenceClient, ALLOWED_BASE_URL } from './confluence-client.js'
import { AuthStore, getAuthStore } from './auth-store.js'
import fsSync from 'node:fs'

import { McpBroker } from './mcp-broker.js'
import { loadSeedConfig } from './mcp-config.js'
import { openDb, upsertKbFts, deleteKbFts, type Db } from './db.js'
import type { SessionInfo } from '../types/run.js'

export type SpawnPi = (args: readonly string[], opts?: SpawnOptions) => ChildProcess

export interface Wiring {
  bus: ChatEventBus
  runStore: RunStore
  tracker: SendRunTracker
  bridge: PiRpcBridge
  sessions: Map<string, SessionInfo>
  kbBus: KbEventBus
  /** Root of the KB tree on disk; subdirs are skills/, agents/, workflows/, memory/. */
  kbRoot: string
  /** Back-compat alias for `<kbRoot>/skills`. */
  skillsDir: string
  agentsDir: string
  workflowsDir: string
  memoryDir: string
  watcher: KbWatcher | null
  /** null when CONFLUENCE_BASE_URL / tokens are missing or misconfigured. */
  confluence: ConfluenceClient | null
  confluenceConfigured: boolean
  confluenceConfigError?: string
  /** Per-workspace auth store. null only when test wiring opts out. */
  authStore: AuthStore | null
  /** Absolute path to the workspace data root (for probe + diagnostics). */
  workspaceRoot: string
  /** Spawn callback for `pi`. Override in tests; defaults to spawning `pi`. */
  spawnPi: SpawnPi
  /** Spawn callback for the terminal command runner. Defaults to /bin/bash. */
  spawnBash?: SpawnPi
  /** MCP client pool. Lazy-connects per server on first use. */
  mcpBroker: McpBroker
  /** SQLite handle for jobs / tasks / FTS5 / chat_messages. Tests may omit it. */
  db?: Db
}

export interface WiringOptions {
  workspaceRoot?: string
  runStore?: RunStore
  /** Override the kb root directory. Defaults to <cwd>/.pi. */
  kbRoot?: string
  /**
   * Legacy: override the skills directory. The kbRoot is then `path.dirname(skillsDir)`.
   * Prefer `kbRoot` for new code; this stays for back-compat with existing tests.
   */
  skillsDir?: string
  /** Whether to instantiate the chokidar watcher. Tests usually pass false. */
  startWatcher?: boolean
  /** Override pi spawn (testing). */
  spawnPi?: SpawnPi
}

declare global {
  // eslint-disable-next-line no-var
  var __wiring: Wiring | undefined
}

export function getWiring(options: WiringOptions = {}): Wiring {
  if (globalThis.__wiring) return globalThis.__wiring
  const root =
    options.workspaceRoot ??
    process.env.PI_WORKSPACE_ROOT ??
    path.join(os.homedir(), '.pi-workspace')
  const bus = getChatEventBus()
  const runStore = options.runStore ?? new RunStore({ root: path.join(root, 'runs') })
  const tracker = getSendRunTracker()
  const bridge = getPiRpcBridge({ runStore, bus, tracker })
  const sessions = new Map<string, SessionInfo>()
  const kbBus = getKbEventBus()

  // Resolve kbRoot. New env var PI_WORKSPACE_KB_ROOT wins. Legacy
  // PI_WORKSPACE_SKILLS_DIR (or options.skillsDir) implies kbRoot = its parent.
  const kbRoot =
    options.kbRoot ??
    process.env.PI_WORKSPACE_KB_ROOT ??
    (options.skillsDir ? path.dirname(options.skillsDir) :
      process.env.PI_WORKSPACE_SKILLS_DIR ? path.dirname(process.env.PI_WORKSPACE_SKILLS_DIR) :
      path.join(process.cwd(), '.pi'))
  const skillsDir = path.join(kbRoot, 'skills')
  const agentsDir = path.join(kbRoot, 'agents')
  const workflowsDir = path.join(kbRoot, 'workflows')
  const memoryDir = path.join(kbRoot, 'memory')

  let watcher: KbWatcher | null = null
  if (options.startWatcher !== false && process.env.PI_WORKSPACE_DISABLE_WATCHER !== '1') {
    // Watcher roots at kbRoot so it picks up changes under skills/agents/workflows/memory.
    watcher = new KbWatcher({ skillsDir: kbRoot, bus: kbBus })
    void watcher.start().catch((err) => {
      console.error('[wiring] kb watcher failed to start:', err)
    })
  }

  // Confluence (unchanged).
  const confluenceBaseUrl = process.env.CONFLUENCE_BASE_URL ?? ALLOWED_BASE_URL
  const confluenceEmail = process.env.ATLASSIAN_EMAIL ?? ''
  const confluenceToken = process.env.ATLASSIAN_API_TOKEN ?? process.env.JIRA_TOKEN ?? ''
  let confluence: ConfluenceClient | null = null
  let confluenceConfigured = false
  let confluenceConfigError: string | undefined
  if (confluenceBaseUrl && confluenceEmail && confluenceToken) {
    try {
      confluence = new ConfluenceClient({
        baseUrl: confluenceBaseUrl,
        email: confluenceEmail,
        apiToken: confluenceToken,
      })
      confluenceConfigured = true
    } catch (err) {
      confluenceConfigError = (err as Error).message
    }
  } else {
    confluenceConfigError = 'CONFLUENCE_BASE_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN (or JIRA_TOKEN) not all set'
  }

  const authStore = getAuthStore({ workspaceRoot: root })
  const spawnPi: SpawnPi = options.spawnPi ?? ((args, opts) => spawn('pi', [...args], opts ?? {}))
  const bashPath = process.env.PI_WORKSPACE_BASH_PATH ?? '/bin/bash'
  const spawnBash: SpawnPi = (args, opts) => spawn(bashPath, [...args], opts ?? {})

  const mcpBroker = new McpBroker(loadSeedConfig())
  const db = openDb(path.join(root, 'data.sqlite'))

  // Wire kb-watcher → kb_fts: re-index any change under skills/agents/
  // workflows/memory/souls. Best-effort; an indexing failure must NOT crash
  // the server.
  kbBus.subscribe((evt) => {
    try {
      const rel = path.relative(kbRoot, evt.path).split(path.sep).join('/')
      const m = /^(skills|agents|workflows|memory|souls)\/([a-z][a-z0-9-]*)/.exec(rel)
      if (!m) return
      const subdir = m[1]!
      const name = m[2]!
      const kind = subdir === 'skills' ? 'skill'
        : subdir === 'agents' ? 'agent'
        : subdir === 'workflows' ? 'workflow'
        : subdir === 'memory' ? 'memory'
        : 'soul'
      if (evt.kind === 'unlink' || evt.kind === 'unlinkDir') {
        deleteKbFts(db, kind, name)
        return
      }
      if (evt.kind === 'add' || evt.kind === 'change') {
        let body = ''
        try { body = fsSync.readFileSync(evt.path, 'utf8') } catch { return }
        upsertKbFts(db, kind, name, body)
      }
    } catch (err) {
      console.error('[wiring] kb_fts indexer threw:', err)
    }
  })

  const w: Wiring = {
    bus, runStore, tracker, bridge, sessions, kbBus,
    kbRoot, skillsDir, agentsDir, workflowsDir, memoryDir,
    watcher,
    confluence, confluenceConfigured, confluenceConfigError,
    authStore, workspaceRoot: root, spawnPi, spawnBash, mcpBroker, db,
  }
  globalThis.__wiring = w
  void authStore.load().catch((err) => {
    console.error('[wiring] auth store load failed:', err)
  })
  return w
}

export function _resetWiringForTests(): void {
  globalThis.__wiring = undefined
  globalThis.__chatEventBus = undefined
  globalThis.__sendRunTracker = undefined
  globalThis.__piRpcBridge = undefined
  globalThis.__kbEventBus = undefined
  globalThis.__authStore = undefined
}
