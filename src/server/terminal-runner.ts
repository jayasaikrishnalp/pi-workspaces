import type { ChildProcess, SpawnOptions } from 'node:child_process'

import type { TerminalStatus } from './terminal-store.js'

export type SpawnLike = (args: readonly string[], opts?: SpawnOptions) => ChildProcess

export interface RunCommandInput {
  command: string
  cwd: string
  timeoutMs: number
}

export interface RunCommandResult {
  status: Exclude<TerminalStatus, 'running'>
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
}

export const STREAM_CAP_BYTES = 1_048_576 // 1 MB
const KILL_GRACE_MS = 1_000

/**
 * Spawn /bin/bash -c <command>, capture stdout/stderr (capped at 1MB each),
 * enforce a timeout. Returns a typed result; never throws.
 *
 * The `spawnBash` parameter is injected so tests can stub.
 */
export async function runCommand(input: RunCommandInput, spawnBash: SpawnLike): Promise<RunCommandResult> {
  const t0 = Date.now()
  let child: ChildProcess
  try {
    child = spawnBash(['-c', input.command], {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
  } catch (err) {
    return {
      status: 'error',
      exitCode: null,
      stdout: '',
      stderr: `spawn failed: ${(err as Error).message}`,
      durationMs: Date.now() - t0,
    }
  }

  const stdoutCapture = new BufferCapture()
  const stderrCapture = new BufferCapture()

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => stdoutCapture.push(String(chunk)))
  child.stderr?.on('data', (chunk) => stderrCapture.push(String(chunk)))

  let timedOut = false
  const timeoutHandle = setTimeout(() => {
    timedOut = true
    try { child.kill('SIGTERM') } catch { /* ignore */ }
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, KILL_GRACE_MS).unref()
  }, input.timeoutMs)
  timeoutHandle.unref()

  return new Promise<RunCommandResult>((resolve) => {
    const finish = (status: RunCommandResult['status'], exitCode: number | null, errMsg?: string) => {
      clearTimeout(timeoutHandle)
      const stderr = errMsg ? `${stderrCapture.toString()}${stderrCapture.size > 0 ? '\n' : ''}${errMsg}` : stderrCapture.toString()
      resolve({
        status,
        exitCode,
        stdout: stdoutCapture.toString(),
        stderr,
        durationMs: Date.now() - t0,
      })
    }
    child.once('error', (err) => {
      finish('error', null, `child error: ${err.message}`)
    })
    child.once('exit', (code, signal) => {
      if (timedOut) {
        finish('timeout', null, `command exceeded ${input.timeoutMs}ms timeout (signal=${signal ?? ''})`)
        return
      }
      finish('completed', code ?? null)
    })
  })
}

class BufferCapture {
  private chunks: string[] = []
  size = 0
  /** Total bytes seen, including those that overflowed the cap. */
  totalSeen = 0

  push(s: string): void {
    this.totalSeen += Buffer.byteLength(s, 'utf8')
    if (this.size >= STREAM_CAP_BYTES) return
    const remaining = STREAM_CAP_BYTES - this.size
    if (Buffer.byteLength(s, 'utf8') <= remaining) {
      this.chunks.push(s)
      this.size += Buffer.byteLength(s, 'utf8')
      return
    }
    // Slice from the start by char count until we hit the byte budget.
    let acc = ''
    let accBytes = 0
    for (const ch of s) {
      const chBytes = Buffer.byteLength(ch, 'utf8')
      if (accBytes + chBytes > remaining) break
      acc += ch
      accBytes += chBytes
    }
    this.chunks.push(acc)
    this.size += accBytes
  }

  toString(): string {
    const joined = this.chunks.join('')
    if (this.totalSeen <= STREAM_CAP_BYTES) return joined
    return `... [truncated, original size ${this.totalSeen} bytes]\n${joined}`
  }
}
