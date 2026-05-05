/**
 * ENV-gated live integration smoke against the real wkengineering.atlassian.net.
 * Runs ONLY when both:
 *   - ATLASSIAN_API_TOKEN (or JIRA_TOKEN as fallback) is set
 *   - ATLASSIAN_EMAIL is set
 * Otherwise emits a `# SKIP` and exits 0 cleanly.
 *
 * This protects CI (no creds) and ensures the live path actually works on a
 * configured developer machine without being flaky on machines that have no
 * access to Atlassian Cloud.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { ALLOWED_BASE_URL, ConfluenceClient } from '../../src/server/confluence-client.ts'

const apiToken = process.env.ATLASSIAN_API_TOKEN ?? process.env.JIRA_TOKEN ?? ''
const email = process.env.ATLASSIAN_EMAIL ?? ''
const HAVE_CREDS = apiToken.length > 0 && email.length > 0

test('live: search "CloudOps" returns ≥1 result', { skip: !HAVE_CREDS }, async () => {
  const c = new ConfluenceClient({
    baseUrl: process.env.CONFLUENCE_BASE_URL ?? ALLOWED_BASE_URL,
    email,
    apiToken,
  })
  const hits = await c.search({ query: 'CloudOps', limit: 5 })
  assert.ok(hits.length >= 1, `expected ≥1 hit; got ${hits.length}`)
  for (const h of hits) {
    assert.ok(/^\d+$/.test(h.id), `id should be numeric, got ${h.id}`)
    assert.ok(h.title.length > 0)
  }
})

test('live: getPage on a search hit returns wrapped sanitized content', { skip: !HAVE_CREDS }, async () => {
  const c = new ConfluenceClient({
    baseUrl: process.env.CONFLUENCE_BASE_URL ?? ALLOWED_BASE_URL,
    email,
    apiToken,
  })
  const hits = await c.search({ query: 'CloudOps', limit: 5 })
  if (hits.length === 0) {
    // No content — skip the page assertion.
    return
  }
  const page = await c.getPage(hits[0].id, 4000)
  assert.match(page.content, /<external_content trusted="false" source="confluence" page-id="\d+">/)
  assert.match(page.content, /<\/external_content>$/)
  assert.doesNotMatch(page.content, /<script>/i)
})
