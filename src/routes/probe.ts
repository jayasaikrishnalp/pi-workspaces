import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { jsonOk } from '../server/http-helpers.js'
import { buildGraph } from '../server/kb-browser.js'
import type { Wiring } from '../server/wiring.js'

export const PROBE_PATH = '/api/probe'

/**
 * Capability matrix the frontend uses to render a sensible "what's working"
 * startup screen. Keeps each probe cheap so this can be polled.
 */
export async function handleProbe(
  _req: IncomingMessage,
  res: ServerResponse,
  w: Wiring,
): Promise<void> {
  const piAuthJsonPath = path.join(os.homedir(), '.pi', 'agent', 'auth.json')
  const piAuthJsonPresent = await fs.access(piAuthJsonPath).then(() => true).catch(() => false)
  let piVersion: string | undefined
  let piOk = false
  let piError: string | undefined
  try {
    // We don't spawn pi here — too expensive for a probe. The bridge spawns
    // it lazily on first send. Instead we infer reachability from auth + a
    // cheap PATH check at boot. For MVP, "ok" mirrors auth.json presence.
    piOk = piAuthJsonPresent
    if (!piAuthJsonPresent) piError = `auth.json missing at ${piAuthJsonPath}`
  } catch (err) {
    piError = (err as Error).message
  }

  const confluenceConfigured = !!w.confluenceConfigured && !!w.confluence
  const confluenceError = w.confluenceConfigError

  let skillsCount = 0
  try {
    const g = await buildGraph(w.skillsDir)
    skillsCount = g.nodes.length
  } catch {
    // ignore — skills count of 0 is the safe default
  }

  jsonOk(res, 200, {
    pi: { ok: piOk, ...(piVersion ? { version: piVersion } : {}), ...(piError ? { error: piError } : {}) },
    confluence: {
      ok: confluenceConfigured,
      configured: confluenceConfigured,
      ...(confluenceError ? { error: confluenceError } : {}),
    },
    skills: { count: skillsCount },
    auth: { piAuthJsonPresent },
    workspace: {
      skillsDir: w.skillsDir,
      runsDir: (w.runStore as { root: string }).root,
    },
  })
}
