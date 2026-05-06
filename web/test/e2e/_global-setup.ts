/**
 * Boots the backend in a child process pointing at a fresh tmp workspace dir.
 *
 * Writes the dev token and the backend port to /tmp/.hive-e2e-state.json so
 * specs can read them.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_FILE = path.join(os.tmpdir(), '.hive-e2e-state.json')
const BACKEND_PORT = 8766

export default async function globalSetup(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-e2e-'))
  const skillsRoot = path.join(root, 'kb')
  fs.mkdirSync(path.join(skillsRoot, 'skills'), { recursive: true })

  const devToken = `e2e-${Math.random().toString(36).slice(2, 10)}`
  fs.writeFileSync(path.join(root, 'dev-token.txt'), devToken + '\n', { mode: 0o600 })

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..')

  // Carefully strip any *_AUTH_DISABLED that the parent shell may have set;
  // we want full auth flow against the real /api/auth/login endpoint.
  const env = { ...process.env }
  delete env.PI_WORKSPACE_AUTH_DISABLED

  const child = spawn('node', ['--import', 'tsx', 'src/server.ts'], {
    cwd: repoRoot,
    env: {
      ...env,
      PORT: String(BACKEND_PORT),
      PI_WORKSPACE_ROOT: root,
      PI_WORKSPACE_KB_ROOT: skillsRoot,
      PI_WORKSPACE_DISABLE_WATCHER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  child.stdout?.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  child.stderr?.on('data', (d) => process.stderr.write(`[backend] ${d}`))

  // Wait for /api/health AND a successful /api/auth/login round-trip — the
  // auth-store loads the dev-token asynchronously after server boot, so a
  // bare /api/health 200 doesn't guarantee the token is honored yet.
  const start = Date.now()
  let healthOk = false
  while (Date.now() - start < 30_000) {
    try {
      if (!healthOk) {
        const h = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/health`)
        if (!h.ok) { await new Promise((r) => setTimeout(r, 250)); continue }
        healthOk = true
      }
      const login = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: devToken }),
      })
      if (login.ok) {
        const state = { root, devToken, backendPort: BACKEND_PORT, pid: child.pid }
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
        console.log(`[e2e] backend up + auth ready at :${BACKEND_PORT}, root=${root}, pid=${child.pid}`)
        return
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  child.kill('SIGTERM')
  throw new Error('backend did not come up + auth-ready within 30s')
}
