/**
 * Helpers for Stage 2 integration tests that drive a real pi child via the
 * workspace HTTP API. The workspace process is spawned as a fresh node child
 * per test so each test gets a clean run-store under a tempdir.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(__dirname, '..', '..')
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'server.ts')

export function tmpWorkspaceRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-workspace-it-'))
}

/** Find a free port the server can bind to. */
export async function findFreePort() {
  const net = await import('node:net')
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Boot the workspace as a child, return { port, child, root, kill }.
 * `root` is a tempdir used as ~/.pi-workspace (passed via PI_WORKSPACE_ROOT).
 * `kill` shuts down cleanly via SIGTERM with a fallback SIGKILL.
 */
export async function bootWorkspace() {
  const port = await findFreePort()
  const root = tmpWorkspaceRoot()
  const env = {
    ...process.env,
    NO_COLOR: '1',
    PORT: String(port),
    PI_WORKSPACE_ROOT: root,
    PI_WORKSPACE_AUTH_DISABLED: '1',
  }
  const child = spawn('node', ['--import', 'tsx', SERVER_PATH], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    detached: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => {
    stdout += d.toString()
  })
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })

  // Wait for "listening on http://127.0.0.1:<port>".
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (stdout.includes(`listening on http://127.0.0.1:${port}`)) break
    if (child.exitCode != null) {
      throw new Error(`workspace exited before listening: ${stderr}\nstdout: ${stdout}`)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!stdout.includes(`listening on http://127.0.0.1:${port}`)) {
    throw new Error(`workspace failed to listen within 10s\nstdout: ${stdout}\nstderr: ${stderr}`)
  }

  return {
    port,
    root,
    child,
    stdoutRef: () => stdout,
    stderrRef: () => stderr,
    async kill() {
      if (!child.pid || child.exitCode != null) return
      const exitPromise = once(child, 'exit')
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        try {
          child.kill('SIGTERM')
        } catch {
          // ignore
        }
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // ignore
        }
      }, 6_000)
      await exitPromise
      clearTimeout(timer)
    },
  }
}

export async function fetchJson(port, path, init = {}) {
  const url = `http://127.0.0.1:${port}${path}`
  const res = await fetch(url, init)
  const text = await res.text()
  let body = null
  try {
    body = text.length > 0 ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body }
}

export async function createSession(port) {
  const r = await fetchJson(port, '/api/sessions', { method: 'POST' })
  if (r.status !== 201) throw new Error(`createSession failed ${r.status}: ${JSON.stringify(r.body)}`)
  return r.body.sessionKey
}

export async function submitPrompt(port, sessionKey, message) {
  const r = await fetchJson(port, '/api/send-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionKey, message }),
  })
  return r
}

/**
 * Open the SSE stream and collect events until either:
 * - a stop predicate returns true, OR
 * - the stream ends naturally, OR
 * - timeoutMs elapses.
 * Returns { events, ended, timedOut }.
 */
export async function collectSse(
  port,
  pathAndQuery,
  { stopOn, timeoutMs = 60_000 } = {},
) {
  const url = `http://127.0.0.1:${port}${pathAndQuery}`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let timedOut = false
  ac.signal.addEventListener('abort', () => {
    timedOut = true
  })

  const events = []
  let ended = false

  try {
    const res = await fetch(url, { signal: ac.signal })
    if (res.status !== 200) {
      const body = await res.text().catch(() => '')
      clearTimeout(timer)
      return { status: res.status, events: [], ended: false, timedOut: false, body }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        ended = true
        break
      }
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const evt = parseSseBlock(block)
        if (evt) {
          events.push(evt)
          if (stopOn && stopOn(evt, events)) {
            ac.abort()
          }
        }
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError') throw err
  } finally {
    clearTimeout(timer)
  }
  return { status: 200, events, ended, timedOut }
}

function parseSseBlock(block) {
  const lines = block.split('\n').filter((l) => l.length > 0)
  let id, event, dataLines = []
  let isComment = true
  for (const line of lines) {
    if (line.startsWith(':')) continue
    isComment = false
    if (line.startsWith('id: ')) id = line.slice(4)
    else if (line.startsWith('event: ')) event = line.slice(7)
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6))
  }
  if (isComment) return null
  let data = null
  if (dataLines.length > 0) {
    const raw = dataLines.join('\n')
    try {
      data = JSON.parse(raw)
    } catch {
      data = raw
    }
  }
  return { id, event, data }
}
