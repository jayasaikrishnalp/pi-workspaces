import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/**
 * Static provider catalog matching pi v0.73's built-in registry. Each provider
 * has a kind (oauth/key/local) which drives the status check, plus a curated
 * model list (we don't shell out to `pi --list-models` per request — that
 * would mean spawning pi for every probe; the static map is fine for the
 * hackathon and refreshes on workspace start).
 */

export type ProviderKind = 'oauth' | 'key' | 'local'
export type ProviderStatus = 'configured' | 'unconfigured' | 'detected' | 'error'

export interface ProviderSpec {
  id: string
  name: string
  kind: ProviderKind
  /** Env var that holds the API key (key kind only). */
  envVar?: string
  /** Curated model list; pi v0.73's defaults. */
  models: string[]
}

const CATALOG: ProviderSpec[] = [
  {
    id: 'github-copilot',
    name: 'OpenAI Codex (GitHub Copilot)',
    kind: 'oauth',
    models: [
      'claude-sonnet-4.6',
      'claude-opus-4.6',
      'gpt-4.1',
      'gpt-5',
      'o1',
      'gemini-2.5-pro',
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'key',
    envVar: 'ANTHROPIC_API_KEY',
    models: [
      'claude-sonnet-4-6-20251101',
      'claude-opus-4-6-20251101',
      'claude-haiku-4-5-20251001',
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'key',
    envVar: 'OPENAI_API_KEY',
    models: ['gpt-4.1', 'gpt-4o', 'o1', 'gpt-4o-mini'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'key',
    envVar: 'OPENROUTER_API_KEY',
    models: [
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-4o',
      'google/gemini-2.5-pro',
      'meta-llama/llama-3.3-70b-instruct',
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    kind: 'key',
    envVar: 'GOOGLE_API_KEY',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  {
    id: 'x-ai',
    name: 'xAI Grok',
    kind: 'key',
    envVar: 'XAI_API_KEY',
    models: ['grok-4', 'grok-4-mini'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'key',
    envVar: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    kind: 'local',
    models: [], // populated dynamically from /api/tags
  },
]

export interface Provider extends ProviderSpec {
  status: ProviderStatus
  statusReason?: string
}

export interface ProvidersClientOptions {
  fetch?: typeof fetch
  ollamaUrl?: string
  ollamaTimeoutMs?: number
  authJsonPath?: string
  settingsJsonPath?: string
  env?: NodeJS.ProcessEnv
}

const DEFAULTS = {
  ollamaUrl: 'http://localhost:11434/api/tags',
  ollamaTimeoutMs: 1_000,
  authJsonPath: path.join(os.homedir(), '.pi', 'agent', 'auth.json'),
  settingsJsonPath: path.join(os.homedir(), '.pi', 'agent', 'settings.json'),
}

export class ProvidersClient {
  private opts: Required<Omit<ProvidersClientOptions, 'env'>> & { env: NodeJS.ProcessEnv }

  constructor(opts: ProvidersClientOptions = {}) {
    this.opts = {
      fetch: opts.fetch ?? fetch,
      ollamaUrl: opts.ollamaUrl ?? DEFAULTS.ollamaUrl,
      ollamaTimeoutMs: opts.ollamaTimeoutMs ?? DEFAULTS.ollamaTimeoutMs,
      authJsonPath: opts.authJsonPath ?? DEFAULTS.authJsonPath,
      settingsJsonPath: opts.settingsJsonPath ?? DEFAULTS.settingsJsonPath,
      env: opts.env ?? process.env,
    }
  }

  async listProviders(): Promise<Provider[]> {
    const auth = await this.readAuthJson()
    const out: Provider[] = []
    for (const spec of CATALOG) {
      if (spec.kind === 'oauth') {
        const configured = !!auth && typeof auth === 'object' && spec.id in auth
        out.push({
          ...spec,
          status: configured ? 'configured' : 'unconfigured',
          statusReason: configured ? undefined : `no entry for ${spec.id} in ~/.pi/agent/auth.json`,
          models: configured ? spec.models : [],
        })
      } else if (spec.kind === 'key') {
        const v = spec.envVar ? this.opts.env[spec.envVar] : undefined
        const configured = typeof v === 'string' && v.length > 0
        out.push({
          ...spec,
          status: configured ? 'configured' : 'unconfigured',
          statusReason: configured ? undefined : `${spec.envVar} is not set`,
          models: configured ? spec.models : [],
        })
      } else {
        const r = await this.probeOllama()
        out.push({ ...spec, ...r })
      }
    }
    return out
  }

  async getActive(): Promise<{ providerId: string | null; modelId: string | null }> {
    const settings = await this.readSettingsJson()
    if (!settings || typeof settings !== 'object') return { providerId: null, modelId: null }
    const providerId = typeof settings.defaultProvider === 'string' ? settings.defaultProvider : null
    const modelId = typeof settings.defaultModelId === 'string' ? settings.defaultModelId : null
    return { providerId, modelId }
  }

  /**
   * Validates and atomically updates pi's settings.json. Throws Error with
   * code property on validation failure.
   */
  async setActive(providerId: string, modelId: string): Promise<void> {
    const providers = await this.listProviders()
    const p = providers.find((x) => x.id === providerId)
    if (!p) {
      throw withCode(new Error(`unknown provider ${providerId}`), 'UNKNOWN_PROVIDER')
    }
    if (p.status !== 'configured' && p.status !== 'detected') {
      throw withCode(new Error(`provider ${providerId} is ${p.status}`), 'PROVIDER_UNCONFIGURED')
    }
    if (!p.models.includes(modelId)) {
      throw withCode(new Error(`unknown model ${modelId} for provider ${providerId}`), 'UNKNOWN_MODEL')
    }
    const existing = (await this.readSettingsJson()) ?? {}
    const updated = { ...existing, defaultProvider: providerId, defaultModelId: modelId }
    const tmp = `${this.opts.settingsJsonPath}.tmp.${process.pid}.${Date.now()}`
    await fs.mkdir(path.dirname(this.opts.settingsJsonPath), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(updated, null, 2))
    await fs.rename(tmp, this.opts.settingsJsonPath)
  }

  private async readAuthJson(): Promise<Record<string, unknown> | null> {
    try {
      const raw = await fs.readFile(this.opts.authJsonPath, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  private async readSettingsJson(): Promise<Record<string, unknown> | null> {
    try {
      const raw = await fs.readFile(this.opts.settingsJsonPath, 'utf8')
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  private async probeOllama(): Promise<{ status: ProviderStatus; statusReason?: string; models: string[] }> {
    try {
      const res = await this.opts.fetch(this.opts.ollamaUrl, {
        signal: AbortSignal.timeout(this.opts.ollamaTimeoutMs),
      })
      if (!res.ok) {
        return { status: 'error', statusReason: `ollama responded ${res.status}`, models: [] }
      }
      const json = (await res.json()) as { models?: Array<{ name?: string }> }
      const names = (json.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string')
      return { status: 'detected', models: names }
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } }
      // Connection refused → unconfigured (the operator just hasn't started ollama).
      const code = e.cause?.code ?? ''
      if (code === 'ECONNREFUSED' || /ECONNREFUSED|fetch failed/.test(e.message)) {
        return { status: 'unconfigured', statusReason: 'ollama is not running on localhost:11434', models: [] }
      }
      return { status: 'error', statusReason: e.message, models: [] }
    }
  }
}

function withCode(err: Error, code: string): Error {
  ;(err as Error & { code?: string }).code = code
  return err
}
