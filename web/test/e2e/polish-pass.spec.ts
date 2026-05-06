/**
 * Polish pass — validates the post-comparison changes:
 *   - Files + Operations sidebar items removed
 *   - Swarm renamed to Teams
 *   - Conductor renamed to Workflows + wired to /api/workflows
 *   - Cost strip visible on every screen
 *   - Light mode toggle in sidebar footer
 *   - Sessions tail shows real recent sessions
 *   - Sessions screen lists every session
 *   - Dashboard quick-action buttons jump to other screens
 */

import { test, expect, loginAndVisit } from './_fixtures'

test.describe('Polish pass: rename + remove + new affordances', () => {
  test('Files + Operations sidebar items are gone; Workflows + Teams are present', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await expect(page.getByTestId('sb-item-files')).toHaveCount(0)
    await expect(page.getByTestId('sb-item-operations')).toHaveCount(0)
    await expect(page.getByTestId('sb-item-conductor')).toHaveCount(0)
    await expect(page.getByTestId('sb-item-swarm')).toHaveCount(0)
    await expect(page.getByTestId('sb-item-workflows')).toBeVisible()
    await expect(page.getByTestId('sb-item-teams')).toBeVisible()
  })

  test('Workflows screen reads from /api/workflows + create modal works', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-workflows').click()
    await expect(page.getByTestId('workflows')).toBeVisible()

    // Seed a skill so the workflow step ref validates.
    const cookie = (await page.context().cookies()).filter((c) => c.name === 'workspace_session').map((c) => `${c.name}=${c.value}`).join('; ')
    const skillName = `wf-skill-${Math.random().toString(36).slice(2, 7)}`
    await page.request.post(`http://127.0.0.1:${state.backendPort}/api/skills`, {
      data: { name: skillName, frontmatter: { description: 'wf seed' }, content: '# x' },
      headers: { Cookie: cookie },
    })

    const wfName = `wf-${Math.random().toString(36).slice(2, 7)}`
    await page.getByTestId('workflows-new').click()
    await page.getByTestId('workflow-create-name').fill(wfName)
    await page.getByTestId('workflow-create-description').fill('polish-pass workflow')
    await page.getByTestId('workflow-create-steps').fill(`skill:${skillName}`)
    await page.getByTestId('workflow-create-submit').click()
    await expect(page.getByTestId(`workflow-row-${wfName}`)).toBeVisible({ timeout: 5_000 })
  })

  test('Cost strip is visible on every screen with placeholder zeros', async ({ page, state }) => {
    await loginAndVisit(page, state)
    for (const target of ['dashboard', 'tasks', 'graph']) {
      await page.getByTestId(`sb-item-${target === 'graph' ? 'knowledge-graph' : target}`).click()
      await expect(page.getByTestId('cost-strip')).toBeVisible()
      await expect(page.getByTestId('cost-in')).toHaveText('0')
      await expect(page.getByTestId('cost-usd')).toHaveText('$0.00')
    }
  })

  test('Theme toggle button flips light <-> default', async ({ page, state }) => {
    await loginAndVisit(page, state)
    // Start in default — body has no vibe-* class.
    await expect(page.locator('body')).not.toHaveClass(/vibe-/)
    await page.getByTestId('sb-theme-toggle').click()
    await expect(page.locator('body')).toHaveClass(/vibe-light/)
    await page.getByTestId('sb-theme-toggle').click()
    await expect(page.locator('body')).not.toHaveClass(/vibe-light/)
  })

  test('Light mode is selectable from Settings vibe picker', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.keyboard.press('Meta+,')
    await expect(page.getByTestId('settings-overlay')).toBeVisible()
    await page.getByTestId('vibe-light').click()
    await expect(page.locator('body')).toHaveClass(/vibe-light/)
  })

  test('Sessions screen lists all sessions and shows the one we just created', async ({ page, state }) => {
    await loginAndVisit(page, state)
    const cookie = (await page.context().cookies()).filter((c) => c.name === 'workspace_session').map((c) => `${c.name}=${c.value}`).join('; ')
    const created = await page.request.post(`http://127.0.0.1:${state.backendPort}/api/sessions`, { headers: { Cookie: cookie } })
    const sessionKey = (await created.json()).sessionKey

    await page.getByTestId('sb-item-sessions').click()
    await expect(page.getByTestId('sessions')).toBeVisible()
    await expect(page.getByTestId(`session-row-${sessionKey}`)).toBeVisible({ timeout: 5_000 })
  })

  test('Dashboard quick-action buttons jump to the right screen', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-dashboard').click()
    await page.getByTestId('dash-action-terminal').click()
    await expect(page.getByTestId('terminal')).toBeVisible()
    await page.getByTestId('sb-item-dashboard').click()
    await page.getByTestId('dash-action-skills').click()
    await expect(page.getByTestId('skills')).toBeVisible()
  })
})
