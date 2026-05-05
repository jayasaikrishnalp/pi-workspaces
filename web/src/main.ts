import { LitElement, html, css } from 'lit'
import { customElement, state } from 'lit/decorators.js'

import * as api from './api.js'
import {
  appendAssistantDelta,
  getState,
  pushMessage,
  setState,
  subscribe,
  type AppState,
} from './store.js'
import { marked } from 'marked'

import './components/probe-banner.js'
import './components/chat-pane.js'
import './components/skills-sidebar.js'
import './components/skill-detail.js'
import './components/kb-graph.js'
import './components/confluence-panel.js'

@customElement('pi-app')
export class PiApp extends LitElement {
  // Use light DOM so Tailwind classes apply directly.
  createRenderRoot() { return this }

  @state() private appState: AppState = getState()
  @state() private tokenInput = ''
  private unsub?: () => void

  connectedCallback() {
    super.connectedCallback()
    this.unsub = subscribe((s) => { this.appState = s })
    this.bootstrap()
  }
  disconnectedCallback() {
    super.disconnectedCallback()
    this.unsub?.()
  }

  private async bootstrap() {
    const ok = await api.checkAuth()
    setState({ authReady: ok })
    if (ok) {
      this.refreshProbe()
      this.refreshSkills()
      this.subscribeKbEvents()
    }
  }

  private async refreshProbe() {
    try {
      const p = await api.getProbe()
      setState({ probe: p })
    } catch (err) {
      console.error('[probe] failed:', err)
    }
  }

  private async refreshSkills() {
    try {
      const g = await api.getKbGraph()
      setState({
        skills: g.nodes.map((n) => ({ id: n.id, description: n.description })),
        edges: g.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind as 'uses' | 'link' })),
      })
    } catch (err) {
      console.error('[skills] failed:', err)
    }
  }

  private subscribeKbEvents() {
    const es = new EventSource('/api/kb/events')
    es.addEventListener('kb.changed', () => { this.refreshSkills() })
    es.onerror = () => { console.warn('[kb-events] error; will retry') }
  }

  private async handleLogin(e: Event) {
    e.preventDefault()
    setState({ authError: null })
    try {
      await api.login(this.tokenInput.trim())
      setState({ authReady: true })
      this.tokenInput = ''
      this.refreshProbe()
      this.refreshSkills()
      this.subscribeKbEvents()
    } catch (err) {
      setState({ authError: (err as { message?: string }).message ?? 'Login failed' })
    }
  }

  render() {
    if (!this.appState.authReady) return this.renderLogin()
    const route = this.appState.route
    return html`
      <div class="flex flex-col h-full">
        <probe-banner .probe=${this.appState.probe}></probe-banner>
        <nav class="flex gap-3 px-4 py-1.5 border-b border-zinc-800 text-xs uppercase tracking-wider">
          <a href="#/" class=${this.linkCls(route, '#/')}>chat</a>
          <a href="#/graph" class=${this.linkCls(route, '#/graph')}>graph</a>
          <a href="#/confluence" class=${this.linkCls(route, '#/confluence')}>confluence</a>
        </nav>
        <div class="flex flex-1 overflow-hidden">
          <skills-sidebar .skills=${this.appState.skills}></skills-sidebar>
          ${this.renderMain(route)}
        </div>
      </div>
    `
  }

  private linkCls(route: string, target: string): string {
    const active = route === target || (target !== '#/' && route.startsWith(target))
    return active ? 'text-sky-400' : 'text-zinc-400 hover:text-zinc-200'
  }

  private renderMain(route: string) {
    if (route.startsWith('#/skill/')) {
      const name = decodeURIComponent(route.slice('#/skill/'.length))
      return html`<skill-detail .name=${name}></skill-detail>`
    }
    if (route.startsWith('#/graph')) {
      // edges are not stored in the lightweight skill list; refetch graph here.
      return html`
        <kb-graph
          .nodes=${this.appState.skills}
          .edges=${this.appState.edges ?? []}
        ></kb-graph>
      `
    }
    if (route.startsWith('#/confluence')) {
      return html`<confluence-panel></confluence-panel>`
    }
    return html`
      <chat-pane
        .messages=${this.appState.messages}
        .activeRunId=${this.appState.activeRunId}
      ></chat-pane>
    `
  }

  private renderLogin() {
    return html`
      <div class="h-full flex items-center justify-center">
        <form
          class="w-96 p-6 rounded-lg border border-zinc-800 bg-zinc-900 space-y-4"
          @submit=${this.handleLogin}
        >
          <h1 class="text-lg font-semibold">CloudOps Workspace</h1>
          <p class="text-sm text-zinc-400">
            Paste the dev token from <code class="text-zinc-200">~/.pi-workspace/dev-token.txt</code>.
          </p>
          <input
            type="password"
            autocomplete="off"
            class="w-full px-3 py-2 rounded bg-zinc-950 border border-zinc-700 focus:outline-none focus:border-sky-500"
            .value=${this.tokenInput}
            @input=${(e: InputEvent) => { this.tokenInput = (e.target as HTMLInputElement).value }}
            placeholder="dev token"
          />
          ${this.appState.authError
            ? html`<p class="text-sm text-red-400">${this.appState.authError}</p>`
            : null}
          <button class="w-full py-2 bg-sky-500 hover:bg-sky-400 rounded font-medium text-zinc-950">
            Sign in
          </button>
        </form>
      </div>
    `
  }
}

// Re-export api + store + marked for component modules.
export { api, marked }
export { appendAssistantDelta, pushMessage, setState, getState }
