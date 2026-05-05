import { LitElement, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { marked } from 'marked'

import * as api from '../api.js'
import { appendAssistantDelta, pushMessage, setState, type ChatMessage } from '../store.js'

@customElement('chat-pane')
export class ChatPane extends LitElement {
  createRenderRoot() { return this }

  @property({ attribute: false }) messages: ChatMessage[] = []
  @property({ attribute: false }) activeRunId: string | null = null

  @state() private input = ''
  @state() private sessionKey: string | null = null
  private es: EventSource | null = null

  protected updated() {
    // Auto-scroll to bottom on new messages.
    requestAnimationFrame(() => {
      const log = this.querySelector('#chat-log')
      if (log) (log as HTMLElement).scrollTop = (log as HTMLElement).scrollHeight
    })
  }

  private async submit(e: Event) {
    e.preventDefault()
    const text = this.input.trim()
    if (!text || this.activeRunId) return
    pushMessage({ kind: 'user', text, ts: Date.now() })
    this.input = ''
    try {
      if (!this.sessionKey) {
        this.sessionKey = await api.createSession()
      }
      const runId = await api.sendPrompt(this.sessionKey, text)
      setState({ activeRunId: runId, sessionKey: this.sessionKey })
      this.openStream(runId)
    } catch (err) {
      pushMessage({
        kind: 'meta',
        text: `error: ${(err as { message?: string }).message ?? 'request failed'}`,
        ts: Date.now(),
      })
    }
  }

  private openStream(runId: string) {
    this.es?.close()
    const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?afterSeq=0`)
    this.es = es

    es.addEventListener('assistant.delta', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data)
      appendAssistantDelta(data.data?.delta ?? '')
    })
    es.addEventListener('tool.call.start', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data)
      pushMessage({ kind: 'tool', text: `→ ${data.data.name}`, toolCallId: data.data.toolCallId, ts: Date.now() })
    })
    es.addEventListener('tool.exec.end', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data)
      pushMessage({
        kind: 'tool',
        text: data.data.ok ? `✓ done` : `✗ ${data.data.error ?? 'failed'}`,
        toolCallId: data.data.toolCallId,
        ts: Date.now(),
      })
    })
    es.addEventListener('run.completed', () => {
      es.close()
      this.es = null
      setState({ activeRunId: null })
    })
    es.onerror = () => {
      console.warn('[run-stream] error; will retry via EventSource')
    }
  }

  private async handleAbort() {
    if (!this.activeRunId) return
    try { await api.abortRun(this.activeRunId) } catch { /* ignore */ }
  }

  render() {
    return html`
      <main class="flex-1 flex flex-col">
        <div id="chat-log" class="flex-1 overflow-y-auto p-4 space-y-3">
          ${this.messages.length === 0
            ? html`<p class="text-zinc-500 text-sm">Type a prompt to start. Pi will answer; you can save anything as a skill.</p>`
            : this.messages.map((m) => this.renderMessage(m))}
        </div>
        <form @submit=${this.submit} class="border-t border-zinc-800 p-3 flex gap-2">
          <textarea
            rows="2"
            class="flex-1 resize-none px-3 py-2 rounded bg-zinc-950 border border-zinc-700 focus:outline-none focus:border-sky-500 text-sm"
            placeholder=${this.activeRunId ? 'still running…' : 'ask pi anything'}
            ?disabled=${!!this.activeRunId}
            .value=${this.input}
            @input=${(e: InputEvent) => { this.input = (e.target as HTMLTextAreaElement).value }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                this.submit(e)
              }
            }}
          ></textarea>
          ${this.activeRunId
            ? html`<button
                type="button"
                class="px-4 py-2 rounded bg-amber-500 hover:bg-amber-400 text-zinc-950 font-medium"
                @click=${this.handleAbort}
              >abort</button>`
            : html`<button
                class="px-4 py-2 rounded bg-sky-500 hover:bg-sky-400 text-zinc-950 font-medium"
                ?disabled=${this.input.trim().length === 0}
              >send</button>`}
        </form>
      </main>
    `
  }

  private renderMessage(m: ChatMessage) {
    if (m.kind === 'tool') {
      return html`<div class="tool-block text-xs text-zinc-300">${m.text}</div>`
    }
    if (m.kind === 'meta') {
      return html`<div class="text-xs text-amber-400 italic">${m.text}</div>`
    }
    const cls = m.kind === 'user' ? 'bg-sky-500/10 text-sky-100' : 'bg-zinc-900 text-zinc-100'
    const html$ = marked.parse(m.text, { breaks: true }) as string
    return html`
      <div class="bubble ${cls} px-4 py-2 rounded">
        <div class="text-xs text-zinc-500 mb-1">${m.kind === 'user' ? 'you' : 'pi'}</div>
        <div .innerHTML=${html$}></div>
      </div>
    `
  }
}
