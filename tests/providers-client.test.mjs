/**
 * Unit tests for ProvidersClient. Inject auth.json/settings.json paths into a
 * tmp dir and stub fetch for ollama, so nothing touches the real ~/.pi.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ProvidersClient } from '../src/server/providers-client.ts'

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'providers-'))
}

function clientFor(root, { auth = null, env = {}, ollama = null } = {}) {
  const authPath = path.join(root, 'auth.json')
  const settingsPath = path.join(root, 'settings.json')
  if (auth !== null) fs.writeFileSync(authPath, JSON.stringify(auth))
  const stubFetch = async () => {
    if (ollama === 'up') {
      return { ok: true, status: 200, json: async () => ({ models: [{ name: 'llama3:latest' }, { name: 'mistral' }] }) }
    }
    if (ollama === 'down') {
      const e = new Error('fetch failed')
      e.cause = { code: 'ECONNREFUSED' }
      throw e
    }
    const e = new Error('fetch failed')
    throw e
  }
  return new ProvidersClient({
    fetch: stubFetch,
    authJsonPath: authPath,
    settingsJsonPath: settingsPath,
    env,
    ollamaTimeoutMs: 200,
  })
}

test('listProviders: oauth configured when auth.json contains the provider id', async () => {
  const root = mkRoot()
  const c = clientFor(root, { auth: { 'github-copilot': { token: 'x' } }, env: {}, ollama: 'down' })
  const list = await c.listProviders()
  const gh = list.find((p) => p.id === 'github-copilot')
  assert.equal(gh.status, 'configured')
  assert.ok(gh.models.length > 0, 'configured oauth provider exposes models')
})

test('listProviders: oauth unconfigured when auth.json missing the provider', async () => {
  const root = mkRoot()
  const c = clientFor(root, { auth: {}, env: {}, ollama: 'down' })
  const gh = (await c.listProviders()).find((p) => p.id === 'github-copilot')
  assert.equal(gh.status, 'unconfigured')
  assert.deepStrictEqual(gh.models, [])
})

test('listProviders: key provider configured iff env var set', async () => {
  const root = mkRoot()
  const c = clientFor(root, { auth: {}, env: { ANTHROPIC_API_KEY: 'sk-test' }, ollama: 'down' })
  const list = await c.listProviders()
  assert.equal(list.find((p) => p.id === 'anthropic').status, 'configured')
  assert.equal(list.find((p) => p.id === 'openai').status, 'unconfigured')
})

test('listProviders: ollama detected populates models from /api/tags', async () => {
  const root = mkRoot()
  const c = clientFor(root, { auth: {}, env: {}, ollama: 'up' })
  const ol = (await c.listProviders()).find((p) => p.id === 'ollama')
  assert.equal(ol.status, 'detected')
  assert.deepStrictEqual(ol.models, ['llama3:latest', 'mistral'])
})

test('listProviders: ollama unconfigured on ECONNREFUSED', async () => {
  const root = mkRoot()
  const c = clientFor(root, { auth: {}, env: {}, ollama: 'down' })
  const ol = (await c.listProviders()).find((p) => p.id === 'ollama')
  assert.equal(ol.status, 'unconfigured')
})

test('setActive: rejects unknown provider with code UNKNOWN_PROVIDER', async () => {
  const root = mkRoot()
  const c = clientFor(root, { auth: {}, env: {}, ollama: 'down' })
  try {
    await c.setActive('nope', 'x')
    assert.fail('expected throw')
  } catch (err) {
    assert.equal(err.code, 'UNKNOWN_PROVIDER')
  }
})

test('setActive: rejects unconfigured provider with PROVIDER_UNCONFIGURED', async () => {
  const root = mkRoot()
  const c = clientFor(root, { auth: {}, env: {}, ollama: 'down' })
  try {
    await c.setActive('anthropic', 'claude-sonnet-4-6-20251101')
    assert.fail('expected throw')
  } catch (err) {
    assert.equal(err.code, 'PROVIDER_UNCONFIGURED')
  }
})

test('setActive: rejects unknown model with UNKNOWN_MODEL', async () => {
  const root = mkRoot()
  const c = clientFor(root, { auth: {}, env: { ANTHROPIC_API_KEY: 'sk' }, ollama: 'down' })
  try {
    await c.setActive('anthropic', 'gpt-4o')
    assert.fail('expected throw')
  } catch (err) {
    assert.equal(err.code, 'UNKNOWN_MODEL')
  }
})

test('setActive: writes settings.json atomically with new defaults', async () => {
  const root = mkRoot()
  const c = clientFor(root, { auth: {}, env: { ANTHROPIC_API_KEY: 'sk' }, ollama: 'down' })
  await c.setActive('anthropic', 'claude-sonnet-4-6-20251101')
  const settings = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'))
  assert.equal(settings.defaultProvider, 'anthropic')
  assert.equal(settings.defaultModelId, 'claude-sonnet-4-6-20251101')
  // No leftover .tmp files in the directory.
  const stragglers = fs.readdirSync(root).filter((f) => f.includes('.tmp'))
  assert.deepStrictEqual(stragglers, [])
})

test('getActive: reads providerId/modelId from settings.json, null when missing', async () => {
  const root = mkRoot()
  const c = clientFor(root, { auth: {}, env: {}, ollama: 'down' })
  const empty = await c.getActive()
  assert.deepStrictEqual(empty, { providerId: null, modelId: null })

  fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ defaultProvider: 'openai', defaultModelId: 'gpt-4o' }))
  const after = await c.getActive()
  assert.deepStrictEqual(after, { providerId: 'openai', modelId: 'gpt-4o' })
})
