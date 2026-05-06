/**
 * Phase 7 — overlays + MCP + Confluence + Settings + ⌘K + ?
 */

import { test, expect, loginAndVisit } from './_fixtures'

test.describe('Overlays + MCP + Settings', () => {
  test('⌘K opens command palette and ESC closes it', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.keyboard.press('Meta+K')
    await expect(page.getByTestId('cmdk-overlay')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('cmdk-overlay')).toBeHidden()
  })

  test('command palette filters screens by typed query', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.keyboard.press('Meta+K')
    await page.getByTestId('cmdk-input').fill('terminal')
    // The Terminal item should be visible.
    await expect(page.getByTestId('cmdk-item-go-terminal')).toBeVisible()
    // Press Enter to navigate.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('terminal')).toBeVisible()
  })

  test('? opens shortcuts overlay listing keyboard shortcuts', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.keyboard.press('?')
    await expect(page.getByTestId('shortcuts-overlay')).toBeVisible()
    await expect(page.getByTestId('shortcuts-overlay')).toContainText('command palette')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('shortcuts-overlay')).toBeHidden()
  })

  test('Settings opens with vibe picker and switches body class', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.keyboard.press('Meta+,')
    await expect(page.getByTestId('settings-overlay')).toBeVisible()

    // Default is no vibe class. Click the terminal vibe.
    await page.getByTestId('vibe-terminal').click()
    await expect(page.locator('body')).toHaveClass(/vibe-terminal/)

    // Switch back to default.
    await page.getByTestId('vibe-default').click()
    await expect(page.locator('body')).not.toHaveClass(/vibe-/)
  })

  test('MCP screen lists ref + context7 from the seed catalog', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-mcp').click()
    await expect(page.getByTestId('mcp')).toBeVisible()
    await expect(page.getByTestId('mcp-server-ref')).toBeVisible()
    await expect(page.getByTestId('mcp-server-context7')).toBeVisible()
  })

  test('Confluence search shows error banner when not configured', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-confluence').click()
    await expect(page.getByTestId('confluence')).toBeVisible()
    await page.getByTestId('confluence-input').fill('cobra')
    await page.getByTestId('confluence-search').click()
    // Test backend has no Confluence config → expect 503
    await expect(page.getByTestId('confluence-error')).toBeVisible({ timeout: 5_000 })
  })
})
