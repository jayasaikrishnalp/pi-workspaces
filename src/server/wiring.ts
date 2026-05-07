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
import { buildSecretEnv } from './secret-store.js'
import { AuthStore, getAuthStore } from './auth-store.js'
import { SecretStore, getSecretStore } from './secret-store.js'
import fsSync from 'node:fs'

import { McpBroker } from './mcp-broker.js'
import { loadSeedConfig } from './mcp-config.js'
import { loadOverlay as loadMcpOverlay } from './mcp-overlay.js'
import { openDb, upsertKbFts, deleteKbFts, type Db } from './db.js'
import { installPersister } from './chat-persister.js'
import { WikiStore } from './wiki-store.js'
import { WikiIngester } from './wiki-ingester.js'
import { WikiWatcher } from './wiki-watcher.js'
import { WorkflowRunsStore } from './workflow-runs-store.js'
import { WorkflowRunBusRegistry } from './workflow-run-bus.js'
import { WorkflowRunner } from './workflow-runner.js'
import { PiBridgeStepExecutor } from './pi-bridge-step-executor.js'
import type { SessionInfo } from '../types/run.js'

const DEFAULT_WIKI_ROOT = path.join(os.homedir(), 'pipeline-information', 'wiki')
const DEFAULT_WIKI_UI_ROOT = path.join(os.homedir(), 'pipeline-information', 'llm-wiki-ui')

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
  /** Per-workspace secret store (env-var bag for MCP servers + skills).
   *  null only when test wiring opts out (the dev token / sessions tests
   *  don't need it). */
  secretStore: SecretStore | null
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
  /** WK pipeline wiki — full-text search store. null when WIKI_ROOT missing. */
  wikiStore: WikiStore | null
  wikiRoot: string | null
  wikiWatcher: WikiWatcher | null
  /** Filesystem root for the llm-wiki-ui static bundle served via
   *  /api/wiki-ui/*. null when the directory is missing. */
  wikiUiRoot: string | null
  /** Ingester instance so /api/wiki/reindex can trigger a manual rebuild. */
  wikiIngester: WikiIngester | null
  /** Workflow run engine — null only when SQLite is absent. */
  workflowRunsStore: WorkflowRunsStore | null
  workflowRunBuses: WorkflowRunBusRegistry | null
  workflowRunner: WorkflowRunner | null
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
  // Construct stores BEFORE the bridge so the bridge can subscribe to
  // secret-store 'change' events (Phase 3 — secret env injection).
  const authStore = getAuthStore({ workspaceRoot: root })
  const secretStore = getSecretStore({ workspaceRoot: root })
  const bridge = getPiRpcBridge({ runStore, bus, tracker, secretStore })
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

  // Confluence — must merge `process.env` with `buildSecretEnv(secretStore)`
  // so creds saved via the Secrets UI work the same as creds exported in the
  // shell. Rebuilt initially after `secretStore.load()` resolves AND on every
  // 'change' event.
  let confluence: ConfluenceClient | null = null
  let confluenceConfigured = false
  let confluenceConfigError: string | undefined
  const rebuildConfluence = (): void => {
    const secretEnv = buildSecretEnv(secretStore)
    const baseUrl = secretEnv.CONFLUENCE_BASE_URL ?? process.env.CONFLUENCE_BASE_URL ?? ALLOWED_BASE_URL
    const email   = secretEnv.ATLASSIAN_EMAIL    ?? process.env.ATLASSIAN_EMAIL    ?? ''
    const token   = secretEnv.ATLASSIAN_API_TOKEN ?? process.env.ATLASSIAN_API_TOKEN ?? secretEnv.JIRA_TOKEN ?? process.env.JIRA_TOKEN ?? ''
    if (baseUrl && email && token) {
      try {
        confluence = new ConfluenceClient({ baseUrl, email, apiToken: token })
        confluenceConfigured = true
        confluenceConfigError = undefined
      } catch (err) {
        confluence = null
        confluenceConfigured = false
        confluenceConfigError = (err as Error).message
      }
    } else {
      confluence = null
      confluenceConfigured = false
      confluenceConfigError = 'CONFLUENCE_BASE_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN (or JIRA_TOKEN) not set in env or secret store (jira.email / jira.token / confluence.base_url)'
    }
  }
  rebuildConfluence() // sync initial pass — reads whatever is already loaded (env, plus any pre-loaded secrets)
  secretStore.on('change', () => {
    rebuildConfluence()
    // Mutate the wiring object below so route handlers see the new client.
    if (globalThis.__wiring) {
      globalThis.__wiring.confluence = confluence
      globalThis.__wiring.confluenceConfigured = confluenceConfigured
      globalThis.__wiring.confluenceConfigError = confluenceConfigError
    }
  })

  const spawnPi: SpawnPi = options.spawnPi ?? ((args, opts) => spawn('pi', [...args], opts ?? {}))
  const bashPath = process.env.PI_WORKSPACE_BASH_PATH ?? '/bin/bash'
  const spawnBash: SpawnPi = (args, opts) => spawn(bashPath, [...args], opts ?? {})

  // MCP catalog = seed (built-in) + overlay (user-added via UI). Overlay
  // entries persist at <workspaceRoot>/mcp-servers.json; if the file is
  // missing or malformed, we boot with seed-only.
  // Important: load secrets synchronously BEFORE building the seed
  // catalog so atlassian / other secret-gated entries register on boot.
  secretStore.loadSync()
  const seedConfig = loadSeedConfig(process.env, secretStore)
  const overlayConfig = loadMcpOverlay(root)
  // De-dup: seed wins on id collision (the user can't shadow a built-in).
  const seedIds = new Set(seedConfig.map((c) => c.id))
  const mcpConfigs = [...seedConfig, ...overlayConfig.filter((c) => !seedIds.has(c.id))]
  const mcpBroker = new McpBroker(mcpConfigs)
  const db = openDb(path.join(root, 'data.sqlite'))

  // Mirror chat-event-bus events into chat_messages so the dashboard
  // intelligence aggregator has data to read. Idempotent + non-blocking.
  installPersister(bus, db)

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

  // Wiki store + ingester + watcher. Optional — disabled if root is missing.
  const wikiRoot = process.env.WIKI_ROOT ?? DEFAULT_WIKI_ROOT
  let wikiStore: WikiStore | null = null
  let wikiWatcher: WikiWatcher | null = null
  let wikiIngester: WikiIngester | null = null
  let resolvedWikiRoot: string | null = null
  if (db && fsSync.existsSync(wikiRoot)) {
    wikiStore = new WikiStore(db)
    resolvedWikiRoot = wikiRoot
    wikiIngester = new WikiIngester(wikiStore, wikiRoot)
    void wikiIngester.ingestAll().then(({ count, durationMs }) => {
      console.log(`[wiki] indexed ${count} docs from ${wikiRoot} in ${durationMs}ms`)
    }).catch((err) => {
      console.error('[wiki] initial ingest failed:', err)
    })
    if (options.startWatcher !== false && process.env.PI_WORKSPACE_DISABLE_WATCHER !== '1') {
      wikiWatcher = new WikiWatcher({ root: wikiRoot, ingester: wikiIngester })
      void wikiWatcher.start().catch((err) => {
        console.error('[wiki] watcher failed to start:', err)
      })
    }
  } else if (db) {
    console.log(`[wiki] root not found (${wikiRoot}); search-wiki disabled`)
  }

  // Static llm-wiki-ui bundle. Optional — null if directory missing.
  const wikiUiCandidate = process.env.WIKI_UI_ROOT ?? DEFAULT_WIKI_UI_ROOT
  const wikiUiRoot = fsSync.existsSync(wikiUiCandidate) ? wikiUiCandidate : null
  if (db && !wikiUiRoot) {
    console.log(`[wiki] ui root not found (${wikiUiCandidate}); /api/wiki-ui disabled`)
  }

  // Workflow run engine — depends on SQLite. Tests without `db` get nulls.
  let workflowRunsStore: WorkflowRunsStore | null = null
  let workflowRunBuses: WorkflowRunBusRegistry | null = null
  let workflowRunner: WorkflowRunner | null = null
  if (db) {
    workflowRunsStore = new WorkflowRunsStore(db)
    workflowRunBuses = new WorkflowRunBusRegistry()
    workflowRunner = new WorkflowRunner({
      store: workflowRunsStore,
      bus: workflowRunBuses,
      // Real pi execution: each workflow step calls bridge.send and
      // collects assistant.delta events from the chat bus. Tests can
      // replace via runner.setExecutor(...).
      executor: new PiBridgeStepExecutor({ bridge, runStore, chatBus: bus }),
    })
  }

  const w: Wiring = {
    bus, runStore, tracker, bridge, sessions, kbBus,
    kbRoot, skillsDir, agentsDir, workflowsDir, memoryDir,
    watcher,
    confluence, confluenceConfigured, confluenceConfigError,
    authStore, secretStore, workspaceRoot: root, spawnPi, spawnBash, mcpBroker, db,
    wikiStore, wikiRoot: resolvedWikiRoot, wikiWatcher,
    wikiUiRoot, wikiIngester,
    workflowRunsStore, workflowRunBuses, workflowRunner,
  }
  globalThis.__wiring = w
  void authStore.load().catch((err) => {
    console.error('[wiring] auth store load failed:', err)
  })
  void secretStore.load().then(() => {
    // Force one rebuild after the on-disk secrets are loaded — the sync
    // rebuild at boot ran before this resolved.
    rebuildConfluence()
    if (globalThis.__wiring) {
      globalThis.__wiring.confluence = confluence
      globalThis.__wiring.confluenceConfigured = confluenceConfigured
      globalThis.__wiring.confluenceConfigError = confluenceConfigError
    }
  }).catch((err) => {
    console.error('[wiring] secret store load failed:', err)
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
  globalThis.__secretStore = undefined
}
