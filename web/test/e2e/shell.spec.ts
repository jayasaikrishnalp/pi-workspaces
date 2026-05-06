/**
 * Phase 1 — workspace shell loads, login works, sidebar collapses, probe
 * banner reflects /api/probe.
 */

import { test, expect, loginAndVisit } from './_fixtures'

test('login flow: bad token → error visible, good token → workspace renders', async ({ page, state }) => {
  await page.goto('/')
  // Login form should render because there's no cookie yet.
  await expect(page.getByTestId('login-form')).toBeVisible()

  // Try a bad token first.
  await page.getByTestId('login-token').fill('definitely-wrong')
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-error')).toBeVisible()

  // Then the real one.
  await page.getByTestId('login-token').fill(state.devToken)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('workspace-shell')).toBeVisible()
})

test('shell: sidebar starts expanded and collapses on click', async ({ page, state }) => {
  await loginAndVisit(page, state)
  await expect(page.getByTestId('sidebar-expanded')).toBeVisible()
  await page.getByTestId('sb-collapse').click()
  await expect(page.getByTestId('sidebar-collapsed')).toBeVisible()
})

test('shell: clicking a sidebar item swaps the active screen', async ({ page, state }) => {
  await loginAndVisit(page, state)
  // 'sessions' stays a placeholder through every phase.
  await page.getByTestId('sb-item-sessions').click()
  await expect(page.getByTestId('screen-sessions')).toBeVisible()
  await expect(page.locator('[data-testid=workspace-shell]')).toHaveAttribute('data-active', 'sessions')
})

test('shell: PREVIEW screens render the badge', async ({ page, state }) => {
  await loginAndVisit(page, state)
  await page.getByTestId('sb-item-swarm').click()
  await expect(page.getByTestId('screen-swarm-preview')).toContainText('PREVIEW')
})

test('probe banner: reflects /api/probe data', async ({ page, state }) => {
  await loginAndVisit(page, state)
  // Wait for the probe to land — banner switches from loading/empty to the
  // populated form with the pi pill.
  await expect(page.getByTestId('probe-pill-pi')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('probe-pill-skills')).toContainText('loaded')
})
