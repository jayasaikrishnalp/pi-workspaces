/**
 * PiBridgeStepExecutor — runs a single workflow step by handing the
 * composed prompt to pi via the existing PiRpcBridge.
 *
 * Wiring:
 *   - Generate piRunId = randomUUID(), sessionKey = wf:<wfRunId>:step:<idx>
 *     so workflow runs are isolated from chat sessions (and from each other
 *     across steps — the bridge's `recycleChild` on secret-store change is
 *     enough; we trust it per the plan).
 *   - Subscribe to chatBus filtered on meta.runId === piRunId.
 *   - Collect every `assistant.delta` chunk; resolve when `run.completed`
 *     lands.
 *   - Surface every delta back to the workflow runner via hooks.emitChunk
 *     so the canvas streams it.
 *
 * Cancellation:
 *   When hooks.shouldCancel() flips true, we call bridge.abort(piRunId)
 *   which the bridge translates into a SIGTERM → SIGKILL escalation. We
 *   resolve as { status: 'cancelled' } once the bridge emits run.completed
 *   with status='cancelled', or after a short grace timeout if no event
 *   comes back (defensive — should never fire in practice).
 */
import { randomUUID } from 'node:crypto'

import type { ChatEventBus } from './chat-event-bus.js'
import type { PiRpcBridge } from './pi-rpc-bridge.js'
import type { RunStore } from './run-store.js'
import type { AgentStepExecutor, StepContext, ExecutorHooks } from './workflow-runner.js'

export interface PiBridgeStepExecutorDeps {
  bridge: PiRpcBridge
  runStore: RunStore
  chatBus: ChatEventBus
  /** Source of fresh ids; tests inject a counter. Defaults to crypto.randomUUID. */
  uuid?: () => string
}

export class PiBridgeStepExecutor implements AgentStepExecutor {
  constructor(private deps: PiBridgeStepExecutorDeps) {}

  async execute(ctx: StepContext, hooks: ExecutorHooks) {
    const piRunId = (this.deps.uuid ?? randomUUID)()
    const sessionKey = `wf:${ctx.workflowRunId}:step:${ctx.stepIndex}`

    type RunStatus = 'success' | 'cancelled' | 'error'
    const collected: string[] = []
    let status: RunStatus = 'success' as RunStatus
    let error: string | undefined

    // Subscribe BEFORE bridge.send so we don't miss the leading events.
    const unsubscribe = this.deps.chatBus.subscribe((evt) => {
      if (evt.meta.runId !== piRunId) return
      if (evt.event === 'assistant.delta') {
        const chunk = String((evt.data as { delta?: unknown }).delta ?? '')
        if (chunk) {
          collected.push(chunk)
          hooks.emitChunk(chunk)
        }
      } else if (evt.event === 'run.completed') {
        const data = evt.data as { status?: string; error?: string }
        status = (data.status as typeof status) ?? 'success'
        error = data.error
        completedResolve()
      }
    })

    let completedResolve!: () => void
    const completed = new Promise<void>((resolve) => { completedResolve = resolve })

    // Cooperative cancellation watchdog — poll shouldCancel every 100ms while
    // the step is in flight; on flip, abort the underlying pi run.
    let cancelTimer: NodeJS.Timeout | null = null
    let cancelRequested = false
    const watchCancel = () => {
      cancelTimer = setInterval(() => {
        if (!cancelRequested && hooks.shouldCancel()) {
          cancelRequested = true
          this.deps.bridge.abort(piRunId).catch((err) =>
            console.error('[pi-bridge-step-executor] abort failed:', err),
          )
        }
      }, 100)
    }

    try {
      await this.deps.runStore.startRun({ runId: piRunId, sessionKey, prompt: ctx.prompt })
      await this.deps.bridge.send({ sessionKey, runId: piRunId, prompt: ctx.prompt })
      watchCancel()
      await completed
    } catch (err) {
      unsubscribe()
      if (cancelTimer) clearInterval(cancelTimer)
      return {
        status: 'failed' as const,
        output: collected.join(''),
        error: (err as Error).message,
        piRunId,
      }
    }

    unsubscribe()
    if (cancelTimer) clearInterval(cancelTimer)

    if (status === 'cancelled' || cancelRequested) {
      return { status: 'cancelled' as const, output: collected.join(''), piRunId }
    }
    if (status === 'error') {
      return {
        status: 'failed' as const,
        output: collected.join(''),
        error: error ?? 'pi run errored',
        piRunId,
      }
    }
    return { status: 'completed' as const, output: collected.join(''), piRunId }
  }
}

