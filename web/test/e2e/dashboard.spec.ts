/**
 * Phase 2 — Dashboard renders all stat cards from live /api/probe and lists
 * recent jobs/tasks from /api/jobs + /api/tasks.
 */

import { test, expect, loginAndVisit } from './_fixtures'

test.describe('Dashboard screen', () => {
  test('default route lands on dashboard with 8 stat cards', async ({ page, state }) => {
    await loginAndVisit(page, state)
    // Dashboard is the default active screen on first boot; explicitly click
    // it to ensure state from a prior test doesn't bias the route.
    await page.getByTestId('sb-item-dashboard').click()
    await expect(page.getByTestId('dashboard')).toBeVisible()

    for (const id of ['skills', 'agents', 'souls', 'workflows', 'memory', 'jobs', 'tasks', 'terminal']) {
      await expect(page.getByTestId(`stat-${id}`)).toBeVisible()
    }
  })

  test('stat values reflect backend state after creating a soul + a task', async ({ page, state }) => {
    const base = `http://127.0.0.1:${state.backendPort}`
    const cookieJar = page.context()
    // Reuse the global setup's session by logging in; cookie persists.
    await loginAndVisit(page, state)

    // Snapshot the current souls count from the rendered DOM.
    const beforeSouls = parseInt(await page.getByTestId('stat-souls-value').innerText() || '0', 10)
    const beforeTasks = parseInt(await page.getByTestId('stat-tasks-value').innerText() || '0', 10)

    // Mutate via the API directly, with a unique name so concurrent specs
    // don't collide on shared backend state.
    const name = `phase2-soul-${Math.random().toString(36).slice(2, 8)}`
    const cookieHeader = (await cookieJar.cookies()).filter((c) => c.name === 'workspace_session').map((c) => `${c.name}=${c.value}`).join('; ')
    const soulRes = await page.request.post(`${base}/api/souls`, {
      data: { name, description: 'phase 2 e2e' },
      headers: { Cookie: cookieHeader },
    })
    expect(soulRes.status()).toBe(201)
    const taskRes = await page.request.post(`${base}/api/tasks`, {
      data: { title: `phase 2 task ${name}` },
      headers: { Cookie: cookieHeader },
    })
    expect(taskRes.status()).toBe(201)

    // Reload to refresh dashboard.
    await page.reload()

    await expect(page.getByTestId('stat-souls-value')).toHaveText(String(beforeSouls + 1))
    await expect(page.getByTestId('stat-tasks-value')).toHaveText(String(beforeTasks + 1))
  })

  test('recent tasks list shows the task we just created', async ({ page, state }) => {
    await loginAndVisit(page, state)
    const base = `http://127.0.0.1:${state.backendPort}`
    const cookieHeader = (await page.context().cookies()).filter((c) => c.name === 'workspace_session').map((c) => `${c.name}=${c.value}`).join('; ')
    const title = `phase2-task-${Math.random().toString(36).slice(2, 8)}`
    const created = await page.request.post(`${base}/api/tasks`, {
      data: { title },
      headers: { Cookie: cookieHeader },
    })
    const taskId = (await created.json()).id

    await page.reload()
    await expect(page.getByTestId(`task-row-${taskId}`)).toContainText(title)
    await expect(page.getByTestId(`task-row-${taskId}`)).toContainText('triage')
  })

  test('mcp pills surface configured server status (ref / context7 from seed catalog)', async ({ page, state }) => {
    await loginAndVisit(page, state)
    // The seed catalog always contains ref + context7. Either may be
    // disconnected (lazy connect) or in error (no key) — what matters is
    // the pills are present.
    await expect(page.getByTestId('mcp-pill-ref')).toBeVisible()
    await expect(page.getByTestId('mcp-pill-context7')).toBeVisible()
  })

  test('Models & Providers panel lists all 8 seed providers with status', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-dashboard').click()
    await expect(page.getByTestId('dash-providers')).toBeVisible({ timeout: 5_000 })
    for (const id of ['github-copilot', 'anthropic', 'openai', 'openrouter', 'google', 'x-ai', 'deepseek', 'ollama']) {
      await expect(page.getByTestId(`provider-row-${id}`)).toBeVisible()
    }
  })

  test('Cost & Usage panel shows the four cost cells', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-dashboard').click()
    await expect(page.getByTestId('dash-cost')).toBeVisible()
    for (const k of ['in', 'out', 'ctx', 'usd']) {
      await expect(page.getByTestId(`dash-cost-${k}`)).toBeVisible()
    }
    await expect(page.getByTestId('dash-cost-usd')).toContainText('$0.00')
  })
})
