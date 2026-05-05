/**
 * Tiny zustand-style store for the frontend. Single source of truth for
 * authState, sessionKey, current run, skills list, probe.
 *
 * Each subscriber gets the whole state on every change. Coarse but fine
 * for the size of this UI.
 */

export interface ChatMessage {
  kind: 'user' | 'assistant' | 'tool' | 'meta'
  text: string
  toolCallId?: string
  ts: number
}

export interface AppState {
  authReady: boolean
  authError: string | null
  sessionKey: string | null
  /** Currently in-flight runId, or null. */
  activeRunId: string | null
  messages: ChatMessage[]
  skills: Array<{ id: string; description?: string }>
  edges: Array<{ source: string; target: string; kind: 'uses' | 'link' }>
  /** undefined while the first probe is loading. */
  probe: Awaited<ReturnType<typeof import('./api.js').getProbe>> | null
  route: string
}

type Listener = (state: AppState) => void

const initial: AppState = {
  authReady: false,
  authError: null,
  sessionKey: null,
  activeRunId: null,
  messages: [],
  skills: [],
  edges: [],
  probe: null,
  route: location.hash || '#/',
}

let state: AppState = initial
const listeners = new Set<Listener>()

export function getState(): AppState {
  return state
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch }
  for (const l of listeners) {
    try { l(state) } catch (err) { console.error('[store] listener:', err) }
  }
}

export function subscribe(l: Listener): () => void {
  listeners.add(l)
  l(state)
  return () => { listeners.delete(l) }
}

export function pushMessage(m: ChatMessage): void {
  setState({ messages: [...state.messages, m] })
}

export function appendAssistantDelta(delta: string): void {
  const last = state.messages[state.messages.length - 1]
  if (last && last.kind === 'assistant' && state.activeRunId) {
    const updated = { ...last, text: last.text + delta }
    setState({ messages: [...state.messages.slice(0, -1), updated] })
  } else {
    pushMessage({ kind: 'assistant', text: delta, ts: Date.now() })
  }
}

window.addEventListener('hashchange', () => {
  setState({ route: location.hash || '#/' })
})
