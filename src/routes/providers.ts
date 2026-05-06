import type { IncomingMessage, ServerResponse } from 'node:http'

import { jsonError, jsonOk, readJsonBody } from '../server/http-helpers.js'
import { ProvidersClient } from '../server/providers-client.js'
import type { Wiring } from '../server/wiring.js'

export const PROVIDERS_LIST_PATH = '/api/providers'
export const PROVIDERS_ACTIVE_PATH = '/api/providers/active'

let cachedClient: ProvidersClient | null = null
function getClient(): ProvidersClient {
  if (!cachedClient) cachedClient = new ProvidersClient()
  return cachedClient
}

export async function handleProvidersList(_req: IncomingMessage, res: ServerResponse, _w: Wiring): Promise<void> {
  try {
    const providers = await getClient().listProviders()
    jsonOk(res, 200, { providers })
  } catch (err) {
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}

export async function handleProvidersActiveGet(_req: IncomingMessage, res: ServerResponse, _w: Wiring): Promise<void> {
  try {
    const active = await getClient().getActive()
    jsonOk(res, 200, active)
  } catch (err) {
    jsonError(res, 500, 'INTERNAL', (err as Error).message)
  }
}

export async function handleProvidersActiveSet(req: IncomingMessage, res: ServerResponse, _w: Wiring): Promise<void> {
  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    jsonError(res, 400, 'BAD_REQUEST', (err as Error).message)
    return
  }
  if (!body || typeof body !== 'object') {
    jsonError(res, 400, 'BAD_REQUEST', 'body must be a JSON object')
    return
  }
  const { providerId, modelId } = body as Record<string, unknown>
  if (typeof providerId !== 'string' || typeof modelId !== 'string') {
    jsonError(res, 400, 'BAD_REQUEST', 'providerId and modelId must be strings')
    return
  }
  try {
    await getClient().setActive(providerId, modelId)
    jsonOk(res, 200, { providerId, modelId })
  } catch (err) {
    const code = (err as Error & { code?: string }).code ?? 'INTERNAL'
    const status =
      code === 'PROVIDER_UNCONFIGURED' ? 400
      : code === 'UNKNOWN_PROVIDER' ? 400
      : code === 'UNKNOWN_MODEL' ? 400
      : 500
    jsonError(res, status, code, (err as Error).message)
  }
}
