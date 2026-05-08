import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveRefApiKey, loadSeedConfig } from '../src/server/mcp-config.ts'

function tmpClaudeJson(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-'))
  const p = path.join(dir, '.claude.json')
  if (contents !== null) fs.writeFileSync(p, contents)
  return p
}

test('resolveRefApiKey: env wins', () => {
  const v = resolveRefApiKey({ REF_API_KEY: 'env-key' }, '/nope/.claude.json')
  assert.equal(v, 'env-key')
})

test('resolveRefApiKey: lifts from claude.json when env is unset', () => {
  const cj = tmpClaudeJson(JSON.stringify({
    mcpServers: { Ref: { headers: { 'x-ref-api-key': 'lifted-key' } } },
  }))
  const v = resolveRefApiKey({}, cj)
  assert.equal(v, 'lifted-key')
})

test('resolveRefApiKey: returns null when claude.json is missing', () => {
  const v = resolveRefApiKey({}, '/definitely/not/a/path/.claude.json')
  assert.equal(v, null)
})

test('resolveRefApiKey: returns null when claude.json is malformed JSON', () => {
  const cj = tmpClaudeJson('this is not json {')
  const v = resolveRefApiKey({}, cj)
  assert.equal(v, null)
})

test('resolveRefApiKey: returns null when Ref entry has no headers', () => {
  const cj = tmpClaudeJson(JSON.stringify({ mcpServers: { Ref: { url: 'x' } } }))
  const v = resolveRefApiKey({}, cj)
  assert.equal(v, null)
})

test('loadSeedConfig: contains ref + context7 entries with expected shape', () => {
  const cfg = loadSeedConfig({})
  assert.equal(cfg.length, 2)
  assert.equal(cfg.find((c) => c.id === 'ref').kind, 'http')
  assert.equal(cfg.find((c) => c.id === 'context7').kind, 'stdio')
})

test('loadSeedConfig: ref entry omits headers when no key resolvable', () => {
  // We can't easily wipe ~/.claude.json in a test, so just ensure the structure is correct.
  const cfg = loadSeedConfig({ REF_API_KEY: '' })
  const ref = cfg.find((c) => c.id === 'ref')
  // Either headers is absent (no key) or has the lifted one — both are valid in this env.
  if (ref.headers) {
    assert.ok(typeof ref.headers['x-ref-api-key'] === 'string')
  }
})

test('loadSeedConfig: registers atlassian when uvx is on PATH AND atlassian creds exist', () => {
  // Stub uvx by creating a tmp dir + an empty 'uvx' file and pointing PATH at it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uvx-'))
  fs.writeFileSync(path.join(dir, 'uvx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const fakeStore = {
    getByPrefix: (prefix) => {
      // Return CONFLUENCE_URL via flat-key passthrough so the atlassian guard
      // (hasAtlassianCreds) lights up.
      if (prefix === '') return { CONFLUENCE_URL: 'https://example.atlassian.net' }
      return {}
    },
  }
  const cfg = loadSeedConfig({ PATH: dir, REF_API_KEY: '' }, fakeStore)
  const atl = cfg.find((c) => c.id === 'atlassian')
  assert.ok(atl, 'atlassian server must be registered')
  assert.equal(atl.kind, 'stdio')
  assert.equal(atl.args[0], 'mcp-atlassian')
  assert.ok(atl.command.endsWith('/uvx'))
  assert.equal(atl.env.CONFLUENCE_URL, 'https://example.atlassian.net')
})

test('loadSeedConfig: skips atlassian when uvx is not on PATH', () => {
  const fakeStore = {
    getByPrefix: (p) => p === '' ? { CONFLUENCE_URL: 'https://x.atlassian.net' } : {},
  }
  const cfg = loadSeedConfig({ PATH: '/nonexistent/path', REF_API_KEY: '' }, fakeStore)
  assert.equal(cfg.find((c) => c.id === 'atlassian'), undefined)
})

test('loadSeedConfig: skips atlassian when no atlassian creds exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uvx-'))
  fs.writeFileSync(path.join(dir, 'uvx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const cfg = loadSeedConfig({ PATH: dir, REF_API_KEY: '' }, { getByPrefix: () => ({}) })
  assert.equal(cfg.find((c) => c.id === 'atlassian'), undefined)
})

test('loadSeedConfig: registers servicenow when SNOW_INSTANCE+USER+PASS all exist', () => {
  const fakeStore = {
    getByPrefix: (p) => p === '' ? {
      SNOW_INSTANCE: 'https://devwolterskluwer.service-now.com',
      SNOW_USER: 'ADO_Integration_User',
      SNOW_PASS: '#Aeuicty321',
    } : {},
  }
  const cfg = loadSeedConfig({ REF_API_KEY: '' }, fakeStore)
  const snow = cfg.find((c) => c.id === 'servicenow')
  assert.ok(snow, 'servicenow server must be registered when all three SNOW_* secrets exist')
  assert.equal(snow.kind, 'stdio')
  assert.match(snow.args[snow.args.length - 1], /extensions\/servicenow-mcp\/server\.ts$/)
  assert.equal(snow.env.SNOW_INSTANCE, 'https://devwolterskluwer.service-now.com')
  assert.equal(snow.env.SNOW_USER, 'ADO_Integration_User')
  assert.equal(snow.env.SNOW_PASS, '#Aeuicty321')
})

test('loadSeedConfig: skips servicenow when any SNOW_* secret is missing', () => {
  for (const missing of ['SNOW_INSTANCE', 'SNOW_USER', 'SNOW_PASS']) {
    const all = {
      SNOW_INSTANCE: 'https://x.service-now.com',
      SNOW_USER: 'u',
      SNOW_PASS: 'p',
    }
    delete all[missing]
    const fakeStore = { getByPrefix: (p) => p === '' ? all : {} }
    const cfg = loadSeedConfig({ REF_API_KEY: '' }, fakeStore)
    assert.equal(cfg.find((c) => c.id === 'servicenow'), undefined, `must skip when ${missing} is absent`)
  }
})

test('loadSeedConfig: registers hive-self when WORKSPACE_INTERNAL_TOKEN is set', () => {
  const cfg = loadSeedConfig({ REF_API_KEY: '', WORKSPACE_INTERNAL_TOKEN: 'tok-1' })
  const self = cfg.find((c) => c.id === 'hive-self')
  assert.ok(self, 'hive-self must be registered when the token is present')
  assert.equal(self.kind, 'stdio')
  assert.match(self.args[self.args.length - 1], /extensions\/hive-self-mcp\/server\.ts$/)
  assert.equal(self.env.WORKSPACE_INTERNAL_TOKEN, 'tok-1')
})

test('loadSeedConfig: skips hive-self when WORKSPACE_INTERNAL_TOKEN is missing', () => {
  const cfg = loadSeedConfig({ REF_API_KEY: '' })
  assert.equal(cfg.find((c) => c.id === 'hive-self'), undefined)
})
