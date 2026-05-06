import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_FILE = path.join(os.tmpdir(), '.hive-e2e-state.json')

export default async function globalTeardown(): Promise<void> {
  if (!fs.existsSync(STATE_FILE)) return
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { pid?: number; root?: string }
    if (state.pid) {
      try { process.kill(state.pid, 'SIGTERM') } catch { /* already dead */ }
      // Give it 1s to flush, then force.
      await new Promise((r) => setTimeout(r, 1000))
      try { process.kill(state.pid, 'SIGKILL') } catch { /* gone */ }
    }
    if (state.root && fs.existsSync(state.root)) {
      fs.rmSync(state.root, { recursive: true, force: true })
    }
  } catch (err) {
    console.error('[e2e] teardown failure (non-fatal):', err)
  } finally {
    try { fs.unlinkSync(STATE_FILE) } catch { /* ignore */ }
  }
}
