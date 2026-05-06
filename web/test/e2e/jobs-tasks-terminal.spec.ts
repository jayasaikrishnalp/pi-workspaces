/**
 * Phase 6 — Jobs + Tasks (kanban) + Terminal exec console.
 */

import { test, expect, loginAndVisit } from './_fixtures'

test.describe('Jobs / Tasks / Terminal', () => {
  test('Tasks: create, advance through state machine, observe in next column', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-tasks').click()
    await expect(page.getByTestId('tasks')).toBeVisible()

    const title = `e2e-task-${Math.random().toString(36).slice(2, 7)}`
    await page.getByTestId('tasks-new').click()
    await page.getByTestId('task-create-title').fill(title)
    await page.getByTestId('task-create-submit').click()

    // Find the card by title (not id, since we don't know it yet).
    const triageCol = page.getByTestId('kanban-col-triage')
    await expect(triageCol).toContainText(title, { timeout: 5_000 })

    // Locate the card and click "→ todo" advance button.
    const card = triageCol.locator('.kanban-card').filter({ hasText: title })
    await card.locator('button').filter({ hasText: 'todo' }).click()
    await expect(page.getByTestId('kanban-col-todo')).toContainText(title)
  })

  test('Terminal: run "echo hello" → stdout and audit row appear', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-terminal').click()
    await expect(page.getByTestId('terminal')).toBeVisible()

    const marker = `e2e-${Math.random().toString(36).slice(2, 6)}`
    await page.getByTestId('terminal-input').fill(`echo ${marker}`)
    await page.getByTestId('terminal-run').click()

    await expect(page.getByTestId('terminal-stdout')).toContainText(marker, { timeout: 10_000 })
    // Audit log shows the command at the top.
    const audit = page.getByTestId('terminal-audit')
    await expect(audit).toContainText(`echo ${marker}`)
  })

  test('Jobs: empty initial list shows empty-state', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-jobs').click()
    // The shared backend may have jobs from prior chat tests; either way the
    // table OR the empty-state should be visible.
    const screen = page.getByTestId('jobs')
    await expect(screen).toBeVisible()
    // Pick whichever child rendered.
    await expect(screen.locator('[data-testid="jobs-table"], [data-testid="jobs-empty"]').first()).toBeVisible()
  })
})
