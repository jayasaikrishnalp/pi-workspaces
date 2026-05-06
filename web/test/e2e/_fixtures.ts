import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base } from '@playwright/test'

const STATE_FILE = path.join(os.tmpdir(), '.hive-e2e-state.json')

interface E2eState {
  root: string
  devToken: string
  backendPort: number
}

function readState(): E2eState {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
}

export const test = base.extend<{
  state: E2eState
}>({
  // Read the shared state file written by globalSetup.
  state: async ({}, use) => {
    await use(readState())
  },
})

/**
 * Helper: log in via /api/auth/login then visit `/`. Use at the start of any
 * spec that needs an authenticated workspace.
 */
export async function loginAndVisit(page: import('@playwright/test').Page, state: E2eState, route = '/'): Promise<void> {
  const res = await page.request.post(`http://127.0.0.1:${state.backendPort}/api/auth/login`, {
    data: { token: state.devToken },
  })
  if (!res.ok()) {
    throw new Error(`auth/login failed (${res.status()}): ${await res.text()}`)
  }
  // Forward the cookie to the browser context.
  const setCookie = res.headers()['set-cookie']
  if (setCookie) {
    const m = /workspace_session=([^;]+)/.exec(setCookie)
    if (m) {
      await page.context().addCookies([{
        name: 'workspace_session',
        value: m[1]!,
        url: 'http://127.0.0.1:5173',
      }])
    }
  }
  await page.goto(route)
}

export { expect } from '@playwright/test'
