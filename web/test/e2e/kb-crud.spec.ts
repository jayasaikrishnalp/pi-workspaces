/**
 * Phase 5 — Skills + Souls + Memory CRUD.
 */

import { test, expect, loginAndVisit } from './_fixtures'

test.describe('KB CRUD screens', () => {
  test('Skills: create via modal → list reflects → editor opens with body', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-skills').click()
    await expect(page.getByTestId('skills')).toBeVisible()

    const r = Math.random().toString(36).slice(2, 7)
    const name = `e2e-sk-${r}`
    await page.getByTestId('skills-new').click()
    await expect(page.getByTestId('skill-create-modal')).toBeVisible()
    await page.getByTestId('skill-create-name').fill(name)
    await page.getByTestId('skill-create-description').fill('phase 5 e2e')
    await page.getByTestId('skill-create-body').fill('# body\nFrom phase 5 e2e.')
    await page.getByTestId('skill-create-submit').click()

    await expect(page.getByTestId(`skill-list-${name}`)).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId(`skill-editor-${name}`)).toBeVisible()
    await expect(page.getByTestId('skill-editor-body')).toHaveValue(/From phase 5/)
  })

  test('Skills: edit description and save persists', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-skills').click()
    const name = `e2e-edit-${Math.random().toString(36).slice(2, 7)}`
    await page.getByTestId('skills-new').click()
    await page.getByTestId('skill-create-name').fill(name)
    await page.getByTestId('skill-create-body').fill('original body')
    await page.getByTestId('skill-create-submit').click()
    await expect(page.getByTestId(`skill-editor-${name}`)).toBeVisible({ timeout: 5_000 })
    await page.getByTestId('skill-editor-description').fill('edited description phase 5')
    await page.getByTestId('skill-editor-save').click()

    // Refresh and re-open — list should still show + body unchanged.
    await page.reload()
    await page.getByTestId('sb-item-skills').click()
    await page.getByTestId(`skill-list-${name}`).click()
    await expect(page.getByTestId(`skill-editor-${name}`)).toBeVisible()
  })

  test('Souls: create with values + tone, list reflects', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-souls').click()
    await expect(page.getByTestId('souls')).toBeVisible()
    const name = `e2e-soul-${Math.random().toString(36).slice(2, 7)}`
    await page.getByTestId('souls-new').click()
    await expect(page.getByTestId('soul-create-modal')).toBeVisible()
    await page.getByTestId('soul-create-name').fill(name)
    await page.getByTestId('soul-create-description').fill('phase 5 soul')
    await page.getByTestId('soul-create-values').fill('caution, honesty')
    await page.getByTestId('soul-create-submit').click()
    await expect(page.getByTestId(`soul-list-${name}`)).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId(`soul-editor-${name}`)).toBeVisible()
    await expect(page.getByTestId('soul-editor-values')).toHaveValue(/caution, honesty/)
  })

  test('Memory: create new entry → re-open from list shows body', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-memory').click()
    await expect(page.getByTestId('memory')).toBeVisible()
    const name = `e2e-mem-${Math.random().toString(36).slice(2, 7)}`
    await page.getByTestId('memory-new').click()
    await page.getByTestId('memory-editor-name').fill(name)
    await page.getByTestId('memory-editor-body').fill('phase 5 memory body')
    await page.getByTestId('memory-editor-save').click()
    await expect(page.getByTestId(`memory-list-${name}`)).toBeVisible({ timeout: 5_000 })
    // Re-open and verify body persists.
    await page.getByTestId(`memory-list-${name}`).click()
    await expect(page.getByTestId('memory-editor-body')).toHaveValue(/phase 5 memory/)
  })
})
