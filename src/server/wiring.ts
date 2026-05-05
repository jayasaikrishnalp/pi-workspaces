import path from 'node:path'
import os from 'node:os'

import { ChatEventBus, getChatEventBus } from './chat-event-bus.js'
import { RunStore } from './run-store.js'
import { SendRunTracker, getSendRunTracker } from './send-run-tracker.js'
import { PiRpcBridge, getPiRpcBridge } from './pi-rpc-bridge.js'
import type { SessionInfo } from '../types/run.js'

export interface Wiring {
  bus: ChatEventBus
  runStore: RunStore
  tracker: SendRunTracker
  bridge: PiRpcBridge
  sessions: Map<string, SessionInfo>
}

export interface WiringOptions {
  workspaceRoot?: string
  runStore?: RunStore
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
  const w: Wiring = { bus, runStore, tracker, bridge, sessions }
  globalThis.__wiring = w
  return w
}

export function _resetWiringForTests(): void {
  globalThis.__wiring = undefined
  globalThis.__chatEventBus = undefined
  globalThis.__sendRunTracker = undefined
  globalThis.__piRpcBridge = undefined
}
