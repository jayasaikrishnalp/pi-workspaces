/**
 * SecretStore module-level tests. Pure file-backed JSON store; no HTTP.
 *
 * Spec:
 *   - load(): idempotent; creates an empty store on first run
 *   - setSecret/getSecret round-trip
 *   - setSecret rejects empty key, > 1KB key, or non-string value
 *   - setSecret trims whitespace from key
 *   - listKeys(): never includes value field; ordered by key
 *   - deleteSecret returns true on hit, false on miss
 *   - getByPrefix returns only matching pairs (used by env injection)
 *   - persistence: file mode 0o600, JSON shape stable across reloads
 *   - corrupt JSON on load: boots clean, does not throw
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SecretStore } from '../src/server/secret-store.ts'

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'secret-store-'))
}

test('load() is idempotent and creates an empty store', async () => {
  const root = tmpRoot()
  const s = new SecretStore({ workspaceRoot: root })
  await s.load()
  await s.load() // second call is a no-op
  assert.deepEqual(s.listKeys(), [])
})

test('setSecret + getSecret round-trips values', async () => {
  const s = new SecretStore({ workspaceRoot: tmpRoot() })
  await s.load()
  await s.setSecret('aws.access_key_id', 'AKIAFAKEEXAMPLE')
  await s.setSecret('aws.secret_access_key', 'wJalrXUtnFEMI/K7MDENG/EXAMPLE')
  assert.equal(s.getSecret('aws.access_key_id'), 'AKIAFAKEEXAMPLE')
  assert.equal(s.getSecret('aws.secret_access_key'), 'wJalrXUtnFEMI/K7MDENG/EXAMPLE')
  assert.equal(s.getSecret('nonexistent'), undefined)
})

test('setSecret trims whitespace from the key', async () => {
  const s = new SecretStore({ workspaceRoot: tmpRoot() })
  await s.load()
  await s.setSecret('  aws.region  ', 'us-east-1')
  assert.equal(s.getSecret('aws.region'), 'us-east-1')
  assert.equal(s.getSecret('  aws.region  '), 'us-east-1')
})

test('setSecret rejects empty/whitespace key', async () => {
  const s = new SecretStore({ workspaceRoot: tmpRoot() })
  await s.load()
  await assert.rejects(() => s.setSecret('', 'x'), /key/i)
  await assert.rejects(() => s.setSecret('   ', 'x'), /key/i)
})

test('setSecret rejects non-string value', async () => {
  const s = new SecretStore({ workspaceRoot: tmpRoot() })
  await s.load()
  await assert.rejects(() => s.setSecret('k', 123), /value/i)
  await assert.rejects(() => s.setSecret('k', null), /value/i)
})

test('setSecret rejects keys > 256 chars', async () => {
  const s = new SecretStore({ workspaceRoot: tmpRoot() })
  await s.load()
  await assert.rejects(() => s.setSecret('a'.repeat(257), 'v'), /too long/i)
})

test('listKeys returns sorted keys with updatedAt; NEVER values', async () => {
  const s = new SecretStore({ workspaceRoot: tmpRoot() })
  await s.load()
  await s.setSecret('zeta', 'v3')
  await s.setSecret('alpha', 'v1')
  await s.setSecret('mid', 'v2')
  const keys = s.listKeys()
  assert.deepEqual(keys.map((e) => e.key), ['alpha', 'mid', 'zeta'])
  for (const e of keys) {
    assert.equal(typeof e.updatedAt, 'number')
    assert.ok(e.updatedAt > 0)
    assert.equal('value' in e, false, `listKeys must not leak values: ${JSON.stringify(e)}`)
  }
})

test('deleteSecret returns true on hit, false on miss; persists', async () => {
  const root = tmpRoot()
  const s = new SecretStore({ workspaceRoot: root })
  await s.load()
  await s.setSecret('k', 'v')
  assert.equal(await s.deleteSecret('k'), true)
  assert.equal(await s.deleteSecret('k'), false)
  assert.equal(s.getSecret('k'), undefined)

  // Reload from disk to confirm persistence.
  const s2 = new SecretStore({ workspaceRoot: root })
  await s2.load()
  assert.equal(s2.getSecret('k'), undefined)
})

test('getByPrefix returns only matching pairs', async () => {
  const s = new SecretStore({ workspaceRoot: tmpRoot() })
  await s.load()
  await s.setSecret('aws.access_key_id', 'A')
  await s.setSecret('aws.secret_access_key', 'B')
  await s.setSecret('azure.client_id', 'C')
  assert.deepEqual(s.getByPrefix('aws.'), {
    'aws.access_key_id': 'A',
    'aws.secret_access_key': 'B',
  })
  assert.deepEqual(s.getByPrefix('azure.'), { 'azure.client_id': 'C' })
  assert.deepEqual(s.getByPrefix('nope.'), {})
})

test('secrets.json is written with mode 0600', async () => {
  const root = tmpRoot()
  const s = new SecretStore({ workspaceRoot: root })
  await s.load()
  await s.setSecret('k', 'v')
  const stat = fs.statSync(path.join(root, 'secrets.json'))
  // Lower 9 bits are permission bits. We want owner read/write only.
  assert.equal(stat.mode & 0o777, 0o600,
    `expected 0o600, got 0o${(stat.mode & 0o777).toString(8)}`)
})

test('persists JSON shape stably across reloads', async () => {
  const root = tmpRoot()
  const s1 = new SecretStore({ workspaceRoot: root })
  await s1.load()
  await s1.setSecret('aws.region', 'us-east-1')

  const raw = JSON.parse(fs.readFileSync(path.join(root, 'secrets.json'), 'utf8'))
  assert.equal(typeof raw['aws.region'], 'object')
  assert.equal(raw['aws.region'].value, 'us-east-1')
  assert.equal(typeof raw['aws.region'].updatedAt, 'number')

  // New instance — same data.
  const s2 = new SecretStore({ workspaceRoot: root })
  await s2.load()
  assert.equal(s2.getSecret('aws.region'), 'us-east-1')
})

test('corrupt secrets.json boots clean (best-effort, never throws)', async () => {
  const root = tmpRoot()
  fs.writeFileSync(path.join(root, 'secrets.json'), 'not json {{{', { mode: 0o600 })
  const s = new SecretStore({ workspaceRoot: root })
  await s.load()
  assert.deepEqual(s.listKeys(), [])
  // Subsequent writes work.
  await s.setSecret('k', 'v')
  assert.equal(s.getSecret('k'), 'v')
})

// ---- Phase 3: env mapper + change events ----------------------------------

import { buildSecretEnv } from '../src/server/secret-store.ts'

test('buildSecretEnv: aws.* secrets map to AWS_* env vars', () => {
  const s = new SecretStore({ workspaceRoot: tmpRoot() })
  // setSecret needs load() first; for a pure unit-style env-build we can
  // use a fake `getByPrefix`-shaped object.
  const fake = {
    getByPrefix: (p) => p === 'aws.' ? {
      'aws.access_key_id': 'AKIAEXAMPLE',
      'aws.secret_access_key': 'sekret',
      'aws.session_token': 'tok',
      'aws.region': 'us-east-1',
    } : {},
  }
  const env = buildSecretEnv(fake)
  assert.equal(env.AWS_ACCESS_KEY_ID, 'AKIAEXAMPLE')
  assert.equal(env.AWS_SECRET_ACCESS_KEY, 'sekret')
  assert.equal(env.AWS_SESSION_TOKEN, 'tok')
  assert.equal(env.AWS_DEFAULT_REGION, 'us-east-1')
  // Originals are NOT included — env should be flat AWS_*/ARM_* only.
  assert.equal(env['aws.access_key_id'], undefined)
})

test('buildSecretEnv: azure.* maps to BOTH ARM_* and AZURE_* (Terraform + SDK conventions)', () => {
  const fake = {
    getByPrefix: (p) => p === 'azure.' ? {
      'azure.client_id': 'cid',
      'azure.client_secret': 'csec',
      'azure.tenant_id': 'tid',
      'azure.subscription_id': 'sid',
    } : {},
  }
  const env = buildSecretEnv(fake)
  // Terraform convention
  assert.equal(env.ARM_CLIENT_ID, 'cid')
  assert.equal(env.ARM_CLIENT_SECRET, 'csec')
  assert.equal(env.ARM_TENANT_ID, 'tid')
  assert.equal(env.ARM_SUBSCRIPTION_ID, 'sid')
  // Azure SDK convention
  assert.equal(env.AZURE_CLIENT_ID, 'cid')
  assert.equal(env.AZURE_CLIENT_SECRET, 'csec')
  assert.equal(env.AZURE_TENANT_ID, 'tid')
  assert.equal(env.AZURE_SUBSCRIPTION_ID, 'sid')
})

test('buildSecretEnv: empty store returns empty object', () => {
  const fake = { getByPrefix: () => ({}) }
  assert.deepEqual(buildSecretEnv(fake), {})
})

test('buildSecretEnv: confluence.base_url + jira.email + jira.token map to atlassian env vars', () => {
  const data = {
    'confluence.': { 'confluence.base_url': 'https://example.atlassian.net' },
    'jira.': { 'jira.email': 'me@example.com', 'jira.token': 'tkn-123' },
  }
  const fake = { getByPrefix: (p) => data[p] ?? {} }
  const env = buildSecretEnv(fake)
  assert.equal(env.CONFLUENCE_BASE_URL, 'https://example.atlassian.net')
  assert.equal(env.JIRA_URL, 'https://example.atlassian.net')
  assert.equal(env.ATLASSIAN_URL, 'https://example.atlassian.net')
  assert.equal(env.ATLASSIAN_EMAIL, 'me@example.com')
  assert.equal(env.JIRA_USERNAME, 'me@example.com')
  assert.equal(env.ATLASSIAN_API_TOKEN, 'tkn-123')
  assert.equal(env.JIRA_TOKEN, 'tkn-123')
  assert.equal(env.JIRA_API_TOKEN, 'tkn-123')
})

test('buildSecretEnv: partial atlassian config emits only configured vars', () => {
  const fake = { getByPrefix: (p) => p === 'jira.' ? { 'jira.token': 'only-token' } : {} }
  const env = buildSecretEnv(fake)
  assert.equal(env.JIRA_TOKEN, 'only-token')
  assert.equal(env.ATLASSIAN_API_TOKEN, 'only-token')
  assert.equal(env.CONFLUENCE_BASE_URL, undefined)
  assert.equal(env.ATLASSIAN_EMAIL, undefined)
})

test('SecretStore emits "change" on setSecret', async () => {
  const s = new SecretStore({ workspaceRoot: tmpRoot() })
  await s.load()
  let count = 0
  s.on('change', () => { count++ })
  await s.setSecret('k', 'v')
  await s.setSecret('k2', 'v2')
  assert.equal(count, 2)
})

test('SecretStore emits "change" on deleteSecret (only when something was deleted)', async () => {
  const s = new SecretStore({ workspaceRoot: tmpRoot() })
  await s.load()
  await s.setSecret('k', 'v')
  let count = 0
  s.on('change', () => { count++ })
  await s.deleteSecret('k')          // hit → fires
  await s.deleteSecret('not-there')  // miss → does NOT fire
  assert.equal(count, 1)
})
