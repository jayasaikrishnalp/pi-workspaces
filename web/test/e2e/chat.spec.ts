/**
 * Phase 3 — Chat surface.
 *
 * Strategy: stub /api/sessions, /api/send-stream, and /api/chat-events at
 * the browser route layer so the test is fully deterministic. The real
 * backend stays running for unrelated probe / souls / tasks calls, but
 * any chat-specific HTTP gets fulfilled by a canned script.
 */

import { test, expect, loginAndVisit } from './_fixtures'

interface CannedEvent { event: string; data: Record<string, unknown> }

async function stubChat(page: import('@playwright/test').Page, opts: { events: CannedEvent[]; sendDelayMs?: number }) {
  // Capture the body of POST /api/sessions (creating a session) → return a
  // canned sessionKey. Capture POST /api/send-stream → 202 ack. Capture
  // GET /api/chat-events → text/event-stream, replay the canned events.
  await page.route('**/api/sessions', async (route, request) => {
    if (request.method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ sessionKey: 'e2e-session' }),
      })
      return
    }
    await route.continue()
  })

  await page.route('**/api/send-stream', async (route) => {
    if (opts.sendDelayMs) await new Promise((r) => setTimeout(r, opts.sendDelayMs))
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ runId: 'e2e-run' }),
    })
  })

  await page.route(/\/api\/chat-events.*/, async (route) => {
    // Emit proper SSE frames: each event includes the `event:` line so the
    // EventSource named-event listeners fire (matches the real backend's
    // sseWrite format in src/server/http-helpers.ts).
    const lines = opts.events
      .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e)}\n\n`)
      .join('')
    await route.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
      body: ': chat-events stub\n\n' + lines,
    })
  })
}

test.describe('Chat screen', () => {
  test('renders the empty state on first mount', async ({ page, state }) => {
    await stubChat(page, { events: [] })
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-chat').click()
    await expect(page.getByTestId('chat-empty')).toBeVisible()
    await expect(page.getByTestId('composer')).toBeVisible()
  })

  test('typing then sending appends a user message and composer clears', async ({ page, state }) => {
    await stubChat(page, { events: [
      { event: 'assistant.start', data: { messageId: 'm1' } },
      { event: 'assistant.delta', data: { messageId: 'm1', delta: 'Hello, on-call.' } },
      { event: 'assistant.completed', data: { messageId: 'm1', text: 'Hello, on-call.', usage: { totalTokens: 12, durationMs: 800 } } },
      { event: 'pi.run.completed', data: {} },
    ]})
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-chat').click()

    // Composer is the stable signal that the chat screen mounted — the
    // empty-state may be racy depending on whether the canned SSE stream
    // landed before this assertion.
    await expect(page.getByTestId('composer')).toBeVisible()

    await page.getByTestId('composer-text').fill('disk on prod-vm-43?')
    await page.getByTestId('composer-send').click()

    // Composer cleared.
    await expect(page.getByTestId('composer-text')).toHaveValue('')

    // User message landed.
    const userMsgs = page.locator('[data-testid^="chat-msg-"][data-role="user"]')
    await expect(userMsgs.first()).toContainText('disk on prod-vm-43')

    // Streamed assistant reply rendered.
    await expect(page.locator('[data-testid^="chat-msg-m1-text"]')).toContainText('Hello, on-call.', { timeout: 5_000 })
  })

  test('renders a tool card with collapsible args + result', async ({ page, state }) => {
    await stubChat(page, { events: [
      { event: 'assistant.start', data: { messageId: 'm2' } },
      { event: 'tool.call.start', data: { toolCallId: 'tc1', name: 'confluence_search', args: { query: 'cobra' } } },
      { event: 'tool.call.end', data: { toolCallId: 'tc1' } },
      { event: 'tool.result', data: { toolCallId: 'tc1', result: { hits: 3 }, durationMs: 1200 } },
      { event: 'assistant.delta', data: { messageId: 'm2', delta: 'Found 3 hits.' } },
      { event: 'assistant.completed', data: { messageId: 'm2', text: 'Found 3 hits.' } },
      { event: 'pi.run.completed', data: {} },
    ]})
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-chat').click()

    await page.getByTestId('composer-text').fill('cobra onboarding')
    await page.getByTestId('composer-send').click()

    const card = page.getByTestId('tool-card-tc1')
    await expect(card).toBeVisible({ timeout: 5_000 })
    await expect(card).toContainText('confluence_search')
    await expect(card).toContainText('completed')

    // Expand the card and see the result block.
    await card.locator('.tool-card-head').click()
    await expect(page.getByTestId('tool-card-tc1-result')).toContainText('"hits": 3')
  })

  test('shows error banner when send-stream fails', async ({ page, state }) => {
    // Override the send-stream stub to return 503.
    await page.route('**/api/sessions', async (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ sessionKey: 'e2e-fail' }) })
      }
      return route.continue()
    })
    await page.route('**/api/send-stream', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'BRIDGE_UNAVAILABLE', message: 'pi not on PATH' } }),
      })
    })
    await page.route(/\/api\/chat-events.*/, async (route) => {
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: ': stub\n\n' })
    })

    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-chat').click()
    await page.getByTestId('composer-text').fill('what is on the docket')
    await page.getByTestId('composer-send').click()

    await expect(page.getByTestId('chat-error')).toContainText('pi not on PATH', { timeout: 5_000 })
  })
})
