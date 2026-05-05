import { LitElement, html } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { marked } from 'marked'

import * as api from '../api.js'

@customElement('skill-detail')
export class SkillDetail extends LitElement {
  createRenderRoot() { return this }

  @property() name = ''
  @state() private body = ''
  @state() private frontmatter: Record<string, unknown> = {}
  @state() private error: string | null = null

  protected updated(changed: Map<string, unknown>) {
    if (changed.has('name')) this.load()
  }

  private async load() {
    this.error = null
    if (!this.name) return
    try {
      const s = await api.getKbSkill(this.name)
      this.body = s.body
      this.frontmatter = s.frontmatter
    } catch (err) {
      this.error = (err as { message?: string }).message ?? 'load failed'
    }
  }

  render() {
    const html$ = this.body ? (marked.parse(this.body, { breaks: true }) as string) : ''
    return html`
      <main class="flex-1 overflow-y-auto p-6">
        <a href="#/" class="text-sm text-sky-400 hover:underline">← back to chat</a>
        <h2 class="mt-4 text-2xl font-semibold">${this.name}</h2>
        ${this.frontmatter.description
          ? html`<p class="mt-1 text-zinc-400">${this.frontmatter.description as string}</p>`
          : null}
        ${this.error ? html`<p class="mt-4 text-red-400">${this.error}</p>` : null}
        <article class="mt-6 prose prose-invert max-w-3xl" .innerHTML=${html$}></article>
      </main>
    `
  }
}
