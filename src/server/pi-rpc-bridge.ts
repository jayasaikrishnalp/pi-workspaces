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
  /** Set when abort() has been called for this run, even if meta.json hasn't
   *  flipped to 'cancelling' yet. Guards the terminalize() path so that an exit
   *  during a fast abort lands as 'cancelled', not 'error'. */
  abortRequested: boolean
  /** Timers armed by abort() for the SIGTERM/SIGKILL escalation. Cleared in finishActive(). */
  killTermTimer?: NodeJS.Timeout
  killForceTimer?: NodeJS.Timeout
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
  /** sessionKey of the most-recent send. When the next send's sessionKey
   *  differs, we tell pi to start a fresh conversation via new_session RPC.
   *  Reset to null whenever the pi child dies (a fresh child = fresh state). */
  private lastSessionKey: string | null = null
  /** When awaiting a new_session ack, the resolver and id are parked here.
   *  handleLine resolves it on the matching response. Must finish BEFORE the
   *  prompt hits stdin — pi processes lines async (void handleInputLine in
   *  rpc-mode.ts), so a back-to-back write would race the prompt against
   *  the still-running newSession() and lose it. */
  private pendingNewSession: { id: string; resolve: () => void; reject: (err: Error) => void } | null = null
  private static readonly NEW_SESSION_ACK_TIMEOUT_MS = 10_000

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
      abortRequested: false,
      completed,
      resolveCompleted,
    }

    // F5: when the Hive sessionKey changes, tell pi to start a fresh
    // conversation BEFORE the prompt. Pi's --mode rpc keeps in-memory state
    // across prompts in a single child; without this, "+ New Session" in
    // Hive would never reset pi's context. The new_session RPC is documented
    // in pi-mono/packages/coding-agent/src/modes/rpc/rpc-types.ts.
    //
    // Pi processes stdin lines without awaiting (void handleInputLine in
    // rpc-mode.ts) — back-to-back writes race. So we must wait for the
    // new_session ack before the prompt hits stdin.
    if (this.lastSessionKey !== null && this.lastSessionKey !== args.sessionKey) {
      await this.requestNewSession(args.runId)
    }
    this.lastSessionKey = args.sessionKey

    const command = JSON.stringify({
      id: args.runId,
      type: 'prompt',
      message: args.prompt,
    })
    this.child!.stdin!.write(command + '\n')
  }

  private requestNewSession(runId: string): Promise<void> {
    const id = `new-session-${runId}`
    const cmd = JSON.stringify({ id, type: 'new_session' })
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingNewSession?.id === id) {
          this.pendingNewSession = null
          reject(new Error(`pi did not ack new_session within ${PiRpcBridge.NEW_SESSION_ACK_TIMEOUT_MS}ms`))
        }
      }, PiRpcBridge.NEW_SESSION_ACK_TIMEOUT_MS).unref()
      this.pendingNewSession = {
        id,
        resolve: () => { clearTimeout(timer); resolve() },
        reject: (err) => { clearTimeout(timer); reject(err) },
      }
      this.child!.stdin!.write(cmd + '\n')
    })
  }

  async waitForActiveCompletion(): Promise<void> {
    if (!this.active) return
    return this.active.completed
  }

  /**
   * Issue an abort for the in-flight run. Writes the abort RPC to pi's stdin,
   * then arms SIGTERM (3s) / SIGKILL (4s) escalation timers against the pi
   * process group. Both timers clear if pi exits cleanly first.
   *
   * Throws NO_ACTIVE_RUN if the requested runId is not the in-flight run.
   */
  async abort(runId: string): Promise<void> {
    if (this.terminated) throw new Error('BRIDGE_TERMINATED')
    const active = this.active
    if (!active || active.runId !== runId) {
      const err = new Error('NO_ACTIVE_RUN')
      ;(err as Error & { code?: string }).code = 'NO_ACTIVE_RUN'
      throw err
    }
    const child = this.child
    if (!child || !child.stdin) {
      throw new Error('BRIDGE_HAS_NO_CHILD')
    }
    // Mark the request immediately so a fast exit (before route's CAS lands)
    // still terminalizes as cancelled, not error.
    active.abortRequested = true

    // 1) Send abort command on stdin.
    const cmd = JSON.stringify({ id: `abort-${runId}`, type: 'abort' })
    child.stdin.write(cmd + '\n')

    // 2) Arm escalation timers against the pi process group.
    const pid = child.pid
    if (typeof pid === 'number' && pid > 0) {
      active.killTermTimer = setTimeout(() => {
        if (this.active !== active) return
        try {
          process.kill(-pid, 'SIGTERM')
        } catch (err) {
          // ESRCH = process already gone; benign.
          const code = (err as NodeJS.ErrnoException).code
          if (code !== 'ESRCH') {
            console.error('[pi-rpc-bridge] SIGTERM failed:', err)
          }
        }
      }, 3_000).unref()

      active.killForceTimer = setTimeout(() => {
        if (this.active !== active) return
        try {
          process.kill(-pid, 'SIGKILL')
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code !== 'ESRCH') {
            console.error('[pi-rpc-bridge] SIGKILL failed:', err)
          }
        }
      }, 4_000).unref()
    }
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
      // Resolve a pending new_session ack if its id matches.
      const pending = this.pendingNewSession
      if (pending && obj.command === 'new_session' && asString(obj.id) === pending.id) {
        this.pendingNewSession = null
        if (obj.success === true) pending.resolve()
        else pending.reject(new Error(`pi rejected new_session: ${asString(obj.error) ?? 'unknown'}`))
        return
      }
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
      if (norm.event === 'run.completed') {
        const status = (norm.data?.status as string) ?? 'success'
        const error = (norm.data?.error as string) ?? null
        // Mark terminalized BEFORE awaiting CAS so a racing child exit
        // does NOT synthesize a duplicate pi.error / run.completed.
        active.terminalized = true
        // Order matters for SSE consistency: persist event → flip meta status
        // → emit on bus. A subscriber receiving the bus event must observe a
        // terminal status on disk if it polls. The finally block guarantees
        // we always clear active state even if disk writes throw — otherwise
        // tracker would leak and waitForActiveCompletion() would never resolve.
        try {
          const enriched = await this.deps.runStore.appendNormalized(
            active.runId,
            active.sessionKey,
            norm,
          )
          // Accept BOTH 'running' and 'cancelling' as expected so that an
          // abort racing the natural agent_end is handled correctly:
          //   - if agent_end wins the race, status flips running → success
          //   - if abort flipped to cancelling first, run.completed flips
          //     cancelling → cancelled (mapper produces status:"cancelled"
          //     from agent_end stopReason:"aborted")
          //   - if natural agent_end arrives but the run is already cancelling,
          //     the CAS still flips cancelling → success only if the mapper's
          //     status is 'success' — but that's rare. The locked spec says
          //     "agent_end first wins" — and the first-writer-wins guarantee
          //     of CAS preserves whichever transition lands first.
          await this.deps.runStore.casStatus(
            active.runId,
            ['running', 'cancelling'],
            status as 'success' | 'error' | 'cancelled',
            { finishedAt: Date.now(), error },
          )
          this.deps.bus.emit(enriched)
        } catch (err) {
          console.error('[pi-rpc-bridge] run.completed persist failed:', err)
        } finally {
          this.finishActive()
        }
      } else {
        await this.persistAndEmit(active, norm)
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
    // If the run was cancelling when pi exited, OR an abort was requested
    // even before the route's CAS landed, the terminal status is 'cancelled',
    // not 'error'. Synthesize the correct run.completed shape so the SSE event
    // matches meta.json on disk.
    const currentStatus = await this.deps.runStore.getStatus(active.runId)
    const isCancellation =
      active.abortRequested || currentStatus === 'cancelling'
    const finalStatus: 'cancelled' | 'error' = isCancellation ? 'cancelled' : 'error'
    const errEvt: NormalizedEvent = {
      event: 'pi.error',
      data: { runId: active.runId, code, message: errorMessage },
    }
    const completedEvt: NormalizedEvent = {
      event: 'run.completed',
      data: { runId: active.runId, status: finalStatus, error: errorMessage },
    }
    try {
      // Persist+emit pi.error first (non-terminal informational event).
      await this.persistAndEmit(active, errEvt)
      // For run.completed: persist → CAS meta → emit, so the bus event
      // signals "disk is fully consistent" to subscribers.
      const enriched = await this.deps.runStore.appendNormalized(
        active.runId,
        active.sessionKey,
        completedEvt,
      )
      await this.deps.runStore.casStatus(
        active.runId,
        ['running', 'cancelling'],
        finalStatus,
        { finishedAt: Date.now(), error: errorMessage },
      )
      this.deps.bus.emit(enriched)
    } catch (err) {
      console.error('[pi-rpc-bridge] terminalize persist failed:', err)
    }
    this.finishActive()
  }

  private finishActive(): void {
    const active = this.active
    if (!active) return
    // Cancel abort escalation timers if a clean exit beat them.
    if (active.killTermTimer) clearTimeout(active.killTermTimer)
    if (active.killForceTimer) clearTimeout(active.killForceTimer)
    this.active = null
    this.deps.tracker.finish(active.sessionKey, active.runId)
    active.resolveCompleted()
  }

  private async onExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const wasActive = this.active
    this.child = null
    // Fresh child gets fresh state; the next send shouldn't think it owes pi
    // a new_session for the previous owner's sessionKey.
    this.lastSessionKey = null
    if (this.pendingNewSession) {
      const p = this.pendingNewSession
      this.pendingNewSession = null
      p.reject(new Error('pi child exited before acking new_session'))
    }

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
    const wait = RESTART_BACKOFF_MS[idx] ?? 0
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
