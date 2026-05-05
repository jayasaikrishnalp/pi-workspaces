// Test helpers: spawn the server in a child process, capture port, ensure cleanup.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { once } from 'node:events'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const SERVER_PATH = path.resolve(__dirname, '..', 'src', 'server.ts')

export async function startServer({ port = 0, timeoutMs = 8000 } = {}) {
  const env = { ...process.env, PORT: String(port), NO_COLOR: '1' }
  const child = spawn('node', ['--import', 'tsx', SERVER_PATH], {
    cwd: path.resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    detached: true,
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d.toString() })
  child.stderr.on('data', (d) => { stderr += d.toString() })

  const startTime = Date.now()
  let boundPort = null
  while (Date.now() - startTime < timeoutMs) {
    const m = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
    if (m) { boundPort = Number(m[1]); break }
    if (child.exitCode != null) break
    await sleep(50)
  }
  if (boundPort == null) {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    throw new Error(`server did not start in ${timeoutMs}ms.\nstdout: ${stdout}\nstderr: ${stderr}`)
  }
  return { child, port: boundPort, getStdout: () => stdout, getStderr: () => stderr }
}

/**
 * Send a signal to the server, wait for clean exit, force-kill on timeout.
 * Important: register the wait BEFORE sending the signal to remove any race.
 */
export async function killServer(handle, signal = 'SIGTERM', timeoutMs = 6000) {
  if (!handle?.child || handle.child.exitCode != null) return handle?.child?.exitCode ?? null
  const exitPromise = once(handle.child, 'exit')
  try { process.kill(-handle.child.pid, signal) } catch {}
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { process.kill(-handle.child.pid, 'SIGKILL') } catch {}
  }, timeoutMs)
  const [code] = await exitPromise
  clearTimeout(timer)
  if (timedOut) {
    throw new Error(`killServer: child did not exit within ${timeoutMs}ms after ${signal}; force-killed with SIGKILL`)
  }
  return code
}

export async function fetchPath(port, path, init = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init)
  const ct = res.headers.get('content-type') ?? ''
  let body = await res.text()
  if (ct.includes('application/json')) {
    try { body = JSON.parse(body) } catch { /* leave as text */ }
  }
  return { status: res.status, headers: res.headers, body }
}
