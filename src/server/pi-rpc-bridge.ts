import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import { mapPiEvent, INITIAL_STATE } from '../events/index.js'
import type { MapperContext, MapperState, NormalizedEvent } from '../events/index.js'

import type { RunStore } from './run-store.js'
import type { ChatEventBus } from './chat-event-bus.js'
import type { SendRunTracker } from './send-run-tracker.js'

interface ActiveRun {
  runId: string
  sessionKey: string
  prompt: string
  state: MapperState
  ctx: MapperContext
  /** Set as soon as a terminating event has been observed/synthesized for this run.
   *  Guards against double termination (e.g. real run.completed + child exit racing). */
  terminalized: boolean
  completed: Promise<void>
  resolveCompleted: () => void
}

export interface BridgeDeps {
  runStore: RunStore
  bus: ChatEventBus
  tracker: SendRunTracker
  spawnPi?: () => ChildProcess
  cwd?: string
}

const RESTART_BACKOFF_MS = [0, 1_000, 5_000, 30_000]

export class PiRpcBridge {
  private child: ChildProcess | null = null
  private active: ActiveRun | null = null
  private stdoutBuf = ''
  private restartAttempt = 0
  private deps: BridgeDeps
  private terminated = false

  constructor(deps: BridgeDeps) {
    this.deps = deps
  }

  /** Send a prompt for a fresh run. Spawns pi if needed. Throws BRIDGE_BUSY if a run is in flight. */
  async send(args: { sessionKey: string; runId: string; prompt: string }): Promise<void> {
    if (this.terminated) throw new Error('BRIDGE_TERMINATED')
    if (this.active) {
      const err = new Error('BRIDGE_BUSY')
      ;(err as Error & { code?: string; activeRunId?: string }).code = 'BRIDGE_BUSY'
      ;(err as Error & { code?: string; activeRunId?: string }).activeRunId = this.active.runId
      throw err
    }
    if (!this.child) await this.spawnChild()

    let resolveCompleted!: () => void
    const completed = new Promise<void>((resolve) => (resolveCompleted = resolve))
    this.active = {
      runId: args.runId,
      sessionKey: args.sessionKey,
      prompt: args.prompt,
      state: { ...INITIAL_STATE },
      ctx: this.makeCtx(args.runId, args.sessionKey, args.prompt),
      terminalized: false,
      completed,
      resolveCompleted,
    }

    const command = JSON.stringify({
      id: args.runId,
      type: 'prompt',
      message: args.prompt,
    })
    this.child!.stdin!.write(command + '\n')
  }

  async waitForActiveCompletion(): Promise<void> {
    if (!this.active) return
    return this.active.completed
  }

  async shutdown(): Promise<void> {
    this.terminated = true
    if (this.child && !this.child.killed) {
      try {
        if (typeof this.child.pid === 'number') {
          process.kill(-this.child.pid, 'SIGTERM')
        } else {
          this.child.kill('SIGTERM')
        }
      } catch {
        // ignore
      }
    }
  }

  private makeCtx(runId: string, sessionKey: string, prompt: string): MapperContext {
    return {
      runId,
      sessionKey,
      prompt,
      nextTurnId: () => randomUUID(),
      nextMessageId: () => randomUUID(),
    }
  }

  private async spawnChild(): Promise<void> {
    const child = this.deps.spawnPi
      ? this.deps.spawnPi()
      : spawn('pi', ['--mode', 'rpc'], {
          cwd: this.deps.cwd ?? process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
        })

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr?.on('data', (chunk: string) => {
      process.stderr.write(`[pi-rpc] ${chunk}`)
    })
    child.on('exit', (code, signal) => this.onExit(code, signal))
    child.on('error', (err) => {
      console.error('[pi-rpc-bridge] spawn error:', err)
    })

    this.child = child
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl)
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (line.length === 0) continue
      void this.handleLine(line)
    }
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Malformed JSON during an active run kills the run. With no active run we
      // just log and move on (could be a stray heartbeat or noise).
      console.error('[pi-rpc-bridge] non-JSON stdout:', line)
      if (this.active) {
        await this.terminalize(`malformed pi stdout: ${line.slice(0, 200)}`, 'PI_MALFORMED_STDOUT')
      }
      return
    }
    const obj = parsed as Record<string, unknown>
    if (obj.type === 'response') {
      // Pi emits a single response per command. success:false means the prompt
      // never reached the agent loop — terminalize the run.
      if (obj.success === false && this.active) {
        const errMsg = `pi rejected prompt: ${asString(obj.error) ?? 'unknown'}`
        await this.terminalize(errMsg, 'PI_PROMPT_REJECTED')
        return
      }
      // Reset restart backoff on first successful response.
      if (obj.success === true) this.restartAttempt = 0
      return
    }
    const active = this.active
    if (!active || active.terminalized) return
    const result = mapPiEvent(parsed, active.state, active.ctx)
    active.state = result.state
    for (const norm of result.events) {
      await this.persistAndEmit(active, norm)
      if (norm.event === 'run.completed') {
        const status = (norm.data?.status as string) ?? 'success'
        const error = (norm.data?.error as string) ?? null
        // Mark terminalized BEFORE awaiting CAS so that a racing child exit
        // does NOT synthesize a duplicate pi.error / run.completed.
        active.terminalized = true
        await this.deps.runStore.casStatus(
          active.runId,
          ['running'],
          status as 'success' | 'error' | 'cancelled',
          { finishedAt: Date.now(), error },
        )
        this.finishActive()
      }
    }
  }

  private async persistAndEmit(active: ActiveRun, norm: NormalizedEvent): Promise<void> {
    try {
      const enriched = await this.deps.runStore.appendNormalized(active.runId, active.sessionKey, norm)
      this.deps.bus.emit(enriched)
    } catch (err) {
      console.error('[pi-rpc-bridge] persist/emit failed:', err)
    }
  }

  /**
   * Synthesize and persist a `pi.error` + `run.completed status:"error"` for the
   * active run, CAS meta, clear tracker, resolve completion. Idempotent — if
   * already terminalized, does nothing.
   */
  private async terminalize(errorMessage: string, code: string): Promise<void> {
    const active = this.active
    if (!active || active.terminalized) return
    active.terminalized = true
    const errEvt: NormalizedEvent = {
      event: 'pi.error',
      data: { runId: active.runId, code, message: errorMessage },
    }
    const completedEvt: NormalizedEvent = {
      event: 'run.completed',
      data: { runId: active.runId, status: 'error', error: errorMessage },
    }
    try {
      await this.persistAndEmit(active, errEvt)
      await this.persistAndEmit(active, completedEvt)
    } catch (err) {
      console.error('[pi-rpc-bridge] terminalize persist failed:', err)
    }
    await this.deps.runStore.casStatus(active.runId, ['running'], 'error', {
      finishedAt: Date.now(),
      error: errorMessage,
    })
    this.finishActive()
  }

  private finishActive(): void {
    const active = this.active
    if (!active) return
    this.active = null
    this.deps.tracker.finish(active.sessionKey, active.runId)
    active.resolveCompleted()
  }

  private async onExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const wasActive = this.active
    this.child = null

    if (wasActive && !wasActive.terminalized) {
      await this.terminalize(
        `pi exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        'PI_EXIT',
      )
    } else if (wasActive && wasActive.terminalized) {
      // Already cleaned up via run.completed handler. Nothing to do.
    }

    if (this.terminated) return
    const idx = Math.min(this.restartAttempt, RESTART_BACKOFF_MS.length - 1)
    const wait = RESTART_BACKOFF_MS[idx]
    this.restartAttempt += 1
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

declare global {
  // eslint-disable-next-line no-var
  var __piRpcBridge: PiRpcBridge | undefined
}

export function getPiRpcBridge(deps: BridgeDeps): PiRpcBridge {
  if (!globalThis.__piRpcBridge) globalThis.__piRpcBridge = new PiRpcBridge(deps)
  return globalThis.__piRpcBridge
}

export function _resetPiRpcBridgeForTests(): void {
  globalThis.__piRpcBridge = undefined
}
