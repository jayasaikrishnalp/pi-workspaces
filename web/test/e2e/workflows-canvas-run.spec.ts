/**
 * E2E: click Run on the seeded "Server Deletion Workflow" → cards animate
 * through the run lifecycle → branches highlight by decision.
 *
 * The backend's POST /api/workflow-runs and SSE stream are stubbed via
 * page.route so the test is hermetic — no real pi spawn, no DB writes.
 */
import { test, expect, loginAndVisit } from './_fixtures'

test('workflow canvas Run drives card states through the lifecycle', async ({ page, state }) => {
  await loginAndVisit(page, state, '/')

  // Stub POST /api/workflow-runs and the SSE stream. Order matters — register
  // the route handlers BEFORE clicking Run.
  await page.route('**/api/workflow-runs', async (route, req) => {
    if (req.method() !== 'POST') return route.fallback()
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ runId: 'e2e-run-1' }),
    })
  })

  // Build a deterministic SSE event sequence for the Server Deletion path.
  const events = [
    { kind: 'run.start', stepCount: 4 },
    { kind: 'step.start', stepId: 'triage', agentId: 'l1-triage-agent' },
    { kind: 'step.output', stepId: 'triage', chunk: 'Triage running…' },
    { kind: 'step.end', stepId: 'triage', agentId: 'l1-triage-agent', status: 'completed', decision: null, next: 'file-chg', output: 'Triage running…' },
    { kind: 'step.start', stepId: 'file-chg', agentId: 'servicenow-agent' },
    { kind: 'step.output', stepId: 'file-chg', chunk: 'Filing CHG…' },
    { kind: 'step.end', stepId: 'file-chg', agentId: 'servicenow-agent', status: 'completed', decision: 'approve', next: 're-confirm', output: 'CHG filed.\nDECISION: approve' },
    { kind: 'step.start', stepId: 're-confirm', agentId: 'l1-triage-agent' },
    { kind: 'step.end', stepId: 're-confirm', agentId: 'l1-triage-agent', status: 'completed', decision: null, next: 'terminate', output: 're-confirmed' },
    { kind: 'step.start', stepId: 'terminate', agentId: 'aws-agent' },
    { kind: 'step.end', stepId: 'terminate', agentId: 'aws-agent', status: 'completed', decision: null, next: null, output: 'terminated' },
    { kind: 'run.end', status: 'completed' },
  ]
  await page.route('**/api/workflow-runs/e2e-run-1/events', async (route) => {
    const body = events.map((e) => `event: ${e.kind}\ndata: ${JSON.stringify({ runId: 'e2e-run-1', ts: Date.now(), ...e })}\n\n`).join('')
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
      body,
    })
  })

  // Navigate to Workflows.
  await page.click('[data-testid="sb-item-workflows"]', { timeout: 10_000 })

  // Pick the Server Deletion workflow from the left list.
  await page.click('[data-testid="wf-list-wf-server-deletion"]', { timeout: 10_000 })

  // Click Run.
  await page.click('[data-testid="wf-run"]')

  // Wait for the run.end event to land — final card should be 'completed'.
  await expect(page.locator('[data-testid="wf-card-terminate"]')).toHaveAttribute('data-status', 'completed', { timeout: 10_000 })

  // All four cards should be 'completed'.
  for (const id of ['triage', 'file-chg', 're-confirm', 'terminate']) {
    await expect(page.locator(`[data-testid="wf-card-${id}"]`)).toHaveAttribute('data-status', 'completed')
  }

  // The decision badge under file-chg should read 'approve'.
  await expect(page.locator('[data-testid="wf-card-decision-file-chg"]')).toContainText('approve')

  // The chosen edge file-chg → re-confirm should have the chosen class;
  // the no-approve sibling (file-chg → end) is not rendered (end terminates).
  const chosen = page.locator('[data-testid="wf-edge-file-chg-re-confirm-approve"]')
  await expect(chosen).toHaveAttribute('data-class', /chosen/)

  // Run status pill in the toolbar should read 'completed'.
  await expect(page.locator('[data-testid="wf-run-status"]')).toHaveText('completed', { timeout: 5_000 })
})
