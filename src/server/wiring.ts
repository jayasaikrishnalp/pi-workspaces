import path from 'node:path'
import os from 'node:os'

import { ChatEventBus, getChatEventBus } from './chat-event-bus.js'
import { RunStore } from './run-store.js'
import { SendRunTracker, getSendRunTracker } from './send-run-tracker.js'
import { PiRpcBridge, getPiRpcBridge } from './pi-rpc-bridge.js'
import { KbEventBus, getKbEventBus } from './kb-event-bus.js'
import { KbWatcher } from './kb-watcher.js'
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
  const w: Wiring = { bus, runStore, tracker, bridge, sessions, kbBus, skillsDir, watcher }
  globalThis.__wiring = w
  return w
}

export function _resetWiringForTests(): void {
  globalThis.__wiring = undefined
  globalThis.__chatEventBus = undefined
  globalThis.__sendRunTracker = undefined
  globalThis.__piRpcBridge = undefined
  globalThis.__kbEventBus = undefined
}
