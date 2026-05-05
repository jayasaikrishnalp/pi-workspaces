import { LitElement, html } from 'lit'
import { customElement, state } from 'lit/decorators.js'

import { api } from '../main.js'

interface Hit {
  id: string
  title: string
  snippet: string
  url: string
}

@customElement('confluence-panel')
export class ConfluencePanel extends LitElement {
  createRenderRoot() { return this }

  @state() private query = ''
  @state() private hits: Hit[] = []
  @state() private selectedId: string | null = null
  @state() private pageContent: string = ''
  @state() private status: 'idle' | 'searching' | 'loading' | 'error' = 'idle'
  @state() private error: string | null = null

  private async runSearch(e: Event) {
    e.preventDefault()
    if (this.query.trim().length === 0) return
    this.status = 'searching'
    this.error = null
    try {
      const r = await api.api<{ hits: Hit[] }>('/api/confluence/search', {
        method: 'POST',
        body: JSON.stringify({ query: this.query.trim() }),
      })
      this.hits = r.hits
      this.status = 'idle'
    } catch (err) {
      this.error = (err as { code?: string; message?: string }).message ?? 'search failed'
      this.status = 'error'
    }
  }

  private async openPage(id: string) {
    this.selectedId = id
    this.status = 'loading'
    try {
      const p = await api.api<{ content: string; title: string }>(
        `/api/confluence/page/${encodeURIComponent(id)}`,
      )
      this.pageContent = p.content
      this.status = 'idle'
    } catch (err) {
      this.error = (err as { message?: string }).message ?? 'page load failed'
      this.status = 'error'
    }
  }

  render() {
    return html`
      <main class="flex-1 flex flex-col">
        <form @submit=${this.runSearch} class="border-b border-zinc-800 p-3 flex gap-2">
          <input
            type="text"
            class="flex-1 px-3 py-2 rounded bg-zinc-950 border border-zinc-700 focus:outline-none focus:border-sky-500 text-sm"
            placeholder="Search Confluence (e.g. CloudOps SDK)"
            .value=${this.query}
            @input=${(e: InputEvent) => { this.query = (e.target as HTMLInputElement).value }}
          />
          <button
            class="px-4 py-2 rounded bg-sky-500 hover:bg-sky-400 text-zinc-950 font-medium disabled:opacity-50"
            ?disabled=${this.query.trim().length === 0}
          >
            ${this.status === 'searching' ? 'searching…' : 'search'}
          </button>
        </form>
        ${this.error ? html`<div class="px-4 py-2 text-amber-400 text-sm">${this.error}</div>` : null}
        <div class="flex flex-1 overflow-hidden">
          <ul class="w-96 shrink-0 overflow-y-auto border-r border-zinc-800">
            ${this.hits.length === 0
              ? html`<li class="px-4 py-3 text-zinc-500 text-sm">No results yet.</li>`
              : this.hits.map(
                  (h) => html`
                    <li
                      class="px-4 py-3 border-b border-zinc-800 cursor-pointer hover:bg-zinc-900 ${this.selectedId === h.id ? 'bg-zinc-900' : ''}"
                      @click=${() => this.openPage(h.id)}
                    >
                      <div class="text-zinc-100">${h.title}</div>
                      <div class="text-xs text-zinc-500 truncate">${h.snippet}</div>
                    </li>
                  `,
                )}
          </ul>
          <div class="flex-1 overflow-y-auto p-6">
            ${this.status === 'loading'
              ? html`<p class="text-zinc-500">loading…</p>`
              : this.pageContent
              ? html`<article class="prose prose-invert max-w-3xl" .innerHTML=${this.pageContent}></article>`
              : html`<p class="text-zinc-500 text-sm">Select a result to read.</p>`}
          </div>
        </div>
      </main>
    `
  }
}
