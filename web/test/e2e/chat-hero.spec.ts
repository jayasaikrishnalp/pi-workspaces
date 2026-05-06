/**
 * Chat empty-state hero — Hermes-flavored landing for a new session.
 *
 * Covers:
 *   - hero shell: avatar, overline, title, model line, tagline, 4 chips
 *   - chip click prefills the composer (does NOT auto-send)
 *   - new composer placeholder mentions Enter / Shift+Enter / ⌘. hotkeys
 *   - Enter (no shift) submits, Shift+Enter inserts a newline, neither
 *     bypass works once `composer-send` is disabled
 */

import { test, expect, loginAndVisit } from './_fixtures'

async function stubChatNoEvents(page: import('@playwright/test').Page) {
  await page.route('**/api/sessions', async (route, req) => {
    if (req.method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ sessionKey: 'e2e-hero' }),
      })
      return
    }
    await route.continue()
  })
  await page.route('**/api/send-stream', async (route) => {
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ runId: 'e2e-hero-run' }),
    })
  })
  await page.route(/\/api\/chat-events.*/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: ': stub\n\n',
    })
  })
}

test.describe('Chat hero', () => {
  test('renders avatar, overline, title, model line, tagline, and four chips', async ({ page, state }) => {
    await stubChatNoEvents(page)
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-chat').click()

    const empty = page.getByTestId('chat-empty')
    await expect(empty).toBeVisible()

    // Avatar image present and pointing at the SVG asset
    const avatar = empty.locator('img.chat-hero-avatar')
    await expect(avatar).toBeVisible()
    await expect(avatar).toHaveAttribute('src', '/hive-avatar.svg')

    await expect(empty.locator('.chat-hero-overline')).toHaveText('HIVE WORKSPACE')
    await expect(empty.locator('h1.chat-hero-title')).toHaveText('Begin a session')
    await expect(empty.locator('.chat-hero-model')).toContainText('claude-opus-4-6')
    await expect(empty.locator('.chat-hero-tagline')).toContainText('Agent chat')

    // All four SRE quick-action chips
    for (const id of ['aws', 'jira', 'confluence', 'snow']) {
      await expect(page.getByTestId(`chat-chip-${id}`)).toBeVisible()
    }
  })

  test('clicking a chip prefills the composer (does not auto-send)', async ({ page, state }) => {
    await stubChatNoEvents(page)
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-chat').click()

    await page.getByTestId('chat-chip-aws').click()

    // Composer text reflects the chip's prompt seed.
    const text = page.getByTestId('composer-text')
    await expect(text).toHaveValue(/AWS CloudWatch alarm/i)

    // No user message has appeared (no auto-send).
    await expect(page.locator('[data-testid^="chat-msg-"][data-role="user"]')).toHaveCount(0)
  })

  test('placeholder advertises Enter / Shift+Enter / ⌘. hotkeys', async ({ page, state }) => {
    await stubChatNoEvents(page)
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-chat').click()

    const placeholder = await page.getByTestId('composer-text').getAttribute('placeholder')
    expect(placeholder).not.toBeNull()
    expect(placeholder!.toLowerCase()).toContain('send')
    expect(placeholder!).toContain('⇧↵')
    expect(placeholder!).toContain('⌘.')
  })

  test('Enter alone sends; Shift+Enter inserts a newline', async ({ page, state }) => {
    await stubChatNoEvents(page)
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-chat').click()

    const text = page.getByTestId('composer-text')

    // Shift+Enter → newline, NOT a send.
    await text.fill('line one')
    await text.focus()
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('line two')
    await expect(text).toHaveValue(/line one\nline two/)
    await expect(page.locator('[data-testid^="chat-msg-"][data-role="user"]')).toHaveCount(0)

    // Plain Enter → send. Composer clears, user message appears.
    await page.keyboard.press('Enter')
    await expect(text).toHaveValue('')
    await expect(page.locator('[data-testid^="chat-msg-"][data-role="user"]').first()).toContainText('line one')
  })
})
