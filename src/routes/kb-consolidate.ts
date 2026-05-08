/**
 * POST /api/kb/consolidate — operator-triggered kb consolidator pass.
 *
 * Constructs the kb-consolidator workflow + agent, calls runner.start(),
 * returns { runId } so the client can watch via SSE / the runs UI.
 *
 * The agent reads `<kbRoot>/index.md` (auto-maintained by the kb-watcher
 * subscriber in wiring.ts), short-circuits when its INDEX_HASH matches
 * the last-seen hash recorded in `consolidator-log.md`, and otherwise
 * diffs+distills into `user.md` / `project.md` plus a fresh audit entry.
 *
 * No body required. Optional `{ force?: boolean }` — when true, the agent
 * is asked to re-run even if the index hash matches. (Useful for testing
 * the deep path on demand.)
 */
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { jsonError, jsonOk, readJsonBody } from '../server/http-helpers.js'
import { RunnerError } from '../server/workflow-runner.js'
import {
  CONSOLIDATE_WORKFLOW,
  CONSOLIDATOR_AGENT,
  CONSOLIDATE_TRIGGERED_BY,
} from '../server/kb-consolidator-defs.js'
import type { Wiring } from '../server/wiring.js'

export const KB_CONSOLIDATE_PATH = '/api/kb/consolidate'

export async function handleKbConsolidate(req: IncomingMessage, res: ServerResponse, w: Wiring): Promise<void> {
  if (!w.workflowRunner || !w.workflowRunsStore) {
    jsonError(res, 503, 'WORKFLOW_RUNS_DISABLED', 'kb consolidate requires a SQLite database')
    return
  }
  // Body is optional. Anything unparseable is treated as {}.
  let body: Record<string, unknown> = {}
  try {
    const parsed = await readJsonBody(req)
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
  } catch { /* silently treat as empty */ }

  const force = body.force === true
  const indexPath = path.join(w.kbRoot, 'index.md')

  try {
    const runId = await w.workflowRunner.start({
      workflow: CONSOLIDATE_WORKFLOW,
      agents: [CONSOLIDATOR_AGENT],
      triggeredBy: CONSOLIDATE_TRIGGERED_BY,
      inputs: {
        index_path: indexPath,
        force: force ? 'true' : 'false',
      },
    })
    jsonOk(res, 202, { runId, workflow: CONSOLIDATE_WORKFLOW.id })
  } catch (err) {
    if (err instanceof RunnerError) {
      const status = err.code === 'ACTIVE_RUN' ? 409 : 500
      jsonError(res, status, err.code, err.message, err.details)
      return
    }
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}
