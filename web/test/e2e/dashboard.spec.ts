/**
 * Dashboard — Hermes-style session intelligence widgets backed by
 * /api/dashboard/intelligence. The pre-rebuild stat cards (stat-skills etc)
 * + provider/cost panels were removed in add-session-intelligence; the new
 * surface is 4 hero cards + 7 widgets.
 */

import { test, expect, loginAndVisit } from './_fixtures'

test.describe('Dashboard — session intelligence', () => {
  test('default route lands on dashboard with the 4 hero cards + 7 widgets', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-dashboard').click()
    await expect(page.getByTestId('dashboard')).toBeVisible()
    for (const id of ['hero-sessions', 'hero-tokens', 'hero-api-calls', 'hero-model']) {
      await expect(page.getByTestId(id)).toBeVisible({ timeout: 8_000 })
    }
    for (const id of ['dash-hero', 'dash-usage-trend', 'dash-top-models', 'dash-cache', 'dash-sessions-intel', 'dash-mix-rhythm', 'dash-tools-usage']) {
      await expect(page.getByTestId(id)).toBeVisible()
    }
  })

  test('window toggle switches the active selection', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-dashboard').click()
    await expect(page.getByTestId('dashboard')).toHaveAttribute('data-window', '7')
    await page.getByTestId('dash-window-30d').click()
    await expect(page.getByTestId('dashboard')).toHaveAttribute('data-window', '30')
  })

  test('cache widget is labeled CACHE CONTRIBUTION (not "hit rate")', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-dashboard').click()
    await expect(page.getByTestId('dash-cache')).toContainText('CACHE CONTRIBUTION')
  })

  test('endpoint returns the full payload shape for window=7d', async ({ page, state }) => {
    await loginAndVisit(page, state)
    const cookie = (await page.context().cookies()).filter((c) => c.name === 'workspace_session').map((c) => `${c.name}=${c.value}`).join('; ')
    const r = await page.request.get(`http://127.0.0.1:${state.backendPort}/api/dashboard/intelligence?window=7d`, { headers: { Cookie: cookie } })
    expect(r.status()).toBe(200)
    const body = await r.json()
    for (const k of ['windowDays', 'sessionsCount', 'apiCallsCount', 'tokenTotals', 'topModels', 'cacheContribution', 'usageTrend', 'sessionsIntelligence', 'hourOfDayHistogram', 'tokenMix', 'topTools', 'activeModel']) {
      expect(body).toHaveProperty(k)
    }
    expect(body.hourOfDayHistogram).toHaveLength(24)
  })

  test('endpoint rejects out-of-range window with INVALID_WINDOW', async ({ page, state }) => {
    await loginAndVisit(page, state)
    const cookie = (await page.context().cookies()).filter((c) => c.name === 'workspace_session').map((c) => `${c.name}=${c.value}`).join('; ')
    const r = await page.request.get(`http://127.0.0.1:${state.backendPort}/api/dashboard/intelligence?window=999d`, { headers: { Cookie: cookie } })
    expect(r.status()).toBe(400)
    const body = await r.json()
    expect(body.error.code).toBe('INVALID_WINDOW')
  })

  test('mcp pills surface from probe (still rendered in shell, not on dashboard)', async ({ page, state }) => {
    await loginAndVisit(page, state)
    // MCP server status now lives on the MCP screen + probe banner. Dashboard
    // intelligence dropped the placeholder cost panel + provider grid in
    // favor of session analytics.
    await expect(page.getByTestId('probe-pill-mcp')).toBeVisible({ timeout: 8_000 })
  })
})
