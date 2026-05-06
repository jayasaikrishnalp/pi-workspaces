/**
 * Live smoke test for the MCP broker against real upstream servers.
 *
 * Run via:  npm run smoke:mcp
 *
 * Skips cleanly if no Ref API key is reachable (env or ~/.claude.json lift).
 *
 * NOT included in the default `npm test` glob — sends one real request to
 * api.ref.tools so we keep it gated behind the dedicated script.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { McpBroker } from '../../src/server/mcp-broker.ts'
import { loadSeedConfig, resolveRefApiKey } from '../../src/server/mcp-config.ts'

test('Ref MCP — list tools and call ref_search_documentation against the real endpoint', async () => {
  const refKey = resolveRefApiKey()
  if (!refKey) {
    console.warn('[smoke:mcp] skipping — no REF_API_KEY in env and lift from ~/.claude.json returned nothing')
    return
  }
  const broker = new McpBroker(loadSeedConfig())
  try {
    const tools = await broker.getToolsForServer('ref')
    assert.ok(tools.length > 0, 'ref should expose at least one tool')
    const search = tools.find((t) => t.toolName.includes('search'))
    assert.ok(search, 'ref should expose a search-style tool')

    const result = await broker.callTool('ref', search.toolName, { query: 'MCP TypeScript SDK' })
    assert.ok(result, 'tool call should return a non-empty result')
    console.info('[smoke:mcp] ref tool call OK; result keys:', Object.keys(result))
  } finally {
    await broker.shutdownAll()
  }
})
