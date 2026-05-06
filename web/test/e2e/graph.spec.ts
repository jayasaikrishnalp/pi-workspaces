/**
 * Phase 4 — Knowledge Graph (hex layout) E2E.
 *
 * Seeds a tiny KB via real backend POSTs (skills + souls + agents that
 * reference them), then asserts the graph renders the nodes + edges
 * + skill detail rail.
 */

import { test, expect, loginAndVisit } from './_fixtures'

async function cookieHeader(page: import('@playwright/test').Page): Promise<string> {
  return (await page.context().cookies())
    .filter((c) => c.name === 'workspace_session')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
}

/**
 * The HexTile uses pointer-capture + a moved-vs-click discriminator on
 * pointerup. Hex tiles overlap visually (axial layout intentionally tight),
 * so a regular click() routinely lands on the wrong tile's SVG. We dispatch
 * pointerdown+pointerup synthetically against the exact testid'd element.
 */
async function clickHex(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.evaluate((n) => {
    const el = document.querySelector(`[data-testid="hex-${n}"]`) as HTMLElement | null
    if (!el) throw new Error(`hex tile ${n} not in DOM`)
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = el.getBoundingClientRect()
    const opts: PointerEventInit = { bubbles: true, cancelable: true, pointerId: 1, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
    el.dispatchEvent(new PointerEvent('pointerdown', opts))
    el.dispatchEvent(new PointerEvent('pointerup', opts))
  }, name)
}

async function ensureSeed(page: import('@playwright/test').Page, base: string): Promise<{ skill: string; soul: string; agent: string }> {
  const cookie = await cookieHeader(page)
  const r = Math.random().toString(36).slice(2, 8)
  const skill = `e2e-skill-${r}`
  const soul = `e2e-soul-${r}`
  const agent = `e2e-agent-${r}`
  await page.request.post(`${base}/api/skills`, {
    data: { name: skill, frontmatter: { description: 'phase 4 e2e' }, content: '# e2e\nbody' },
    headers: { Cookie: cookie },
  })
  await page.request.post(`${base}/api/souls`, {
    data: { name: soul, description: 'phase 4 e2e soul' },
    headers: { Cookie: cookie },
  })
  await page.request.post(`${base}/api/agents`, {
    data: { name: agent, skills: [skill], soul },
    headers: { Cookie: cookie },
  })
  return { skill, soul, agent }
}

test.describe('Graph screen', () => {
  test('renders hex tiles for skills + souls + agents from /api/kb/graph', async ({ page, state }) => {
    await loginAndVisit(page, state)
    const seed = await ensureSeed(page, `http://127.0.0.1:${state.backendPort}`)

    await page.getByTestId('sb-item-knowledge-graph').click()
    await expect(page.getByTestId('graph')).toBeVisible()

    const skillTile = page.getByTestId(`hex-${seed.skill}`)
    const soulTile  = page.getByTestId(`hex-${seed.soul}`)
    const agentTile = page.getByTestId(`hex-${seed.agent}`)
    await expect(skillTile).toBeVisible({ timeout: 10_000 })
    await expect(soulTile).toBeVisible()
    await expect(agentTile).toBeVisible()

    expect(await skillTile.getAttribute('data-source')).toBe('skill')
    expect(await soulTile.getAttribute('data-source')).toBe('soul')
    expect(await agentTile.getAttribute('data-source')).toBe('agent')
  })

  test('clicking a skill tile opens the detail rail with the skill body', async ({ page, state }) => {
    await loginAndVisit(page, state)
    const seed = await ensureSeed(page, `http://127.0.0.1:${state.backendPort}`)

    await page.getByTestId('sb-item-knowledge-graph').click()
    await expect(page.getByTestId(`hex-${seed.skill}`)).toBeVisible({ timeout: 10_000 })
    await clickHex(page, seed.skill)

    await expect(page.getByTestId('skill-detail')).toBeVisible()
    await expect(page.getByTestId('skill-detail-name')).toHaveText(seed.skill)
    await expect(page.getByTestId('skill-detail-body')).toContainText('e2e')

    // Close the rail.
    await page.getByTestId('skill-detail-close').click()
    await expect(page.getByTestId('skill-detail')).toBeHidden()
  })

  test('embodies edge surfaces in detail rail when navigating from agent → soul', async ({ page, state }) => {
    await loginAndVisit(page, state)
    const seed = await ensureSeed(page, `http://127.0.0.1:${state.backendPort}`)
    await page.getByTestId('sb-item-knowledge-graph').click()

    await expect(page.getByTestId(`hex-${seed.agent}`)).toBeVisible({ timeout: 10_000 })
    await clickHex(page, seed.agent)

    // Detail rail shows edges; agent has outgoing 'composes' to skill and
    // 'embodies' to soul. Click the embodies edge to navigate to the soul.
    const embodies = page.getByTestId(`edge-out-${seed.soul}`)
    await expect(embodies).toBeVisible()
    await embodies.click()
    await expect(page.getByTestId('skill-detail-name')).toHaveText(seed.soul)
  })

  test('legend lists the four kinds (skill, agent, workflow, soul)', async ({ page, state }) => {
    await loginAndVisit(page, state)
    await page.getByTestId('sb-item-knowledge-graph').click()
    const legend = page.locator('.graph-legend')
    await expect(legend).toContainText('skill')
    await expect(legend).toContainText('agent')
    await expect(legend).toContainText('workflow')
    await expect(legend).toContainText('soul')
  })
})
