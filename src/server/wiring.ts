import path from 'node:path'
import os from 'node:os'

import { ChatEventBus, getChatEventBus } from './chat-event-bus.js'
import { RunStore } from './run-store.js'
import { SendRunTracker, getSendRunTracker } from './send-run-tracker.js'
import { PiRpcBridge, getPiRpcBridge } from './pi-rpc-bridge.js'
import { KbEventBus, getKbEventBus } from './kb-event-bus.js'
import { KbWatcher } from './kb-watcher.js'
import { ConfluenceClient, ALLOWED_BASE_URL } from './confluence-client.js'
import { AuthStore, getAuthStore } from './auth-store.js'
import type { SessionInfo } from '../types/run.js'

export interface Wiring {
  bus: ChatEventBus
  runStore: RunStore
  tracker: SendRunTracker
  bridge: PiRpcBridge
  sessions: Map<string, SessionInfo>
  kbBus: KbEventBus
  /** Absolute path to the skills directory under the workspace cwd. */
  skillsDir: string
  watcher: KbWatcher | null
  /** null when CONFLUENCE_BASE_URL / tokens are missing or misconfigured. */
  confluence: ConfluenceClient | null
  confluenceConfigured: boolean
  confluenceConfigError?: string
  /** Per-workspace auth store. null only when test wiring opts out. */
  authStore: AuthStore | null
  /** Absolute path to the workspace root (for probe + diagnostics). */
  workspaceRoot: string
}

export interface WiringOptions {
  workspaceRoot?: string
  runStore?: RunStore
  /** Override skillsDir for tests. Defaults to <cwd>/.pi/skills. */
  skillsDir?: string
  /** Whether to instantiate the chokidar watcher. Tests usually pass false. */
  startWatcher?: boolean
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
  const skillsDir =
    options.skillsDir ??
    process.env.PI_WORKSPACE_SKILLS_DIR ??
    path.join(process.cwd(), '.pi', 'skills')
  let watcher: KbWatcher | null = null
  if (options.startWatcher !== false && process.env.PI_WORKSPACE_DISABLE_WATCHER !== '1') {
    watcher = new KbWatcher({ skillsDir, bus: kbBus })
    // Fire-and-forget; the watcher promise resolves on chokidar 'ready'.
    void watcher.start().catch((err) => {
      console.error('[wiring] kb watcher failed to start:', err)
    })
  }
  // Lazy Confluence client: only construct if env is configured AND the
  // base URL matches the allowlist. Failures surface as confluenceConfigError
  // and the routes return 503 CONFLUENCE_UNAVAILABLE.
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

  // Auth store: lazy-loaded (token + sessions read from disk on first use).
  const authStore = getAuthStore({ workspaceRoot: root })

  const w: Wiring = {
    bus, runStore, tracker, bridge, sessions, kbBus, skillsDir, watcher,
    confluence, confluenceConfigured, confluenceConfigError,
    authStore, workspaceRoot: root,
  }
  globalThis.__wiring = w
  // Fire-and-forget load — the middleware tolerates an in-flight load.
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
