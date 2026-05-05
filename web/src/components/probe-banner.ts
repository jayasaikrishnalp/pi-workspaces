import { LitElement, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'

type Probe = {
  pi: { ok: boolean; error?: string }
  confluence: { ok: boolean; configured: boolean; error?: string }
  skills: { count: number }
} | null

@customElement('probe-banner')
export class ProbeBanner extends LitElement {
  createRenderRoot() { return this }

  @property({ attribute: false }) probe: Probe = null

  private dot(ok: boolean): string {
    return ok ? 'bg-emerald-500' : 'bg-amber-500'
  }

  render() {
    const p = this.probe
    if (!p) {
      return html`
        <header class="flex items-center gap-4 px-4 py-2 border-b border-zinc-800 text-sm text-zinc-400">
          <span>checking workspace…</span>
        </header>
      `
    }
    return html`
      <header class="flex items-center gap-6 px-4 py-2 border-b border-zinc-800 text-sm">
        <strong class="font-semibold text-zinc-200">CloudOps Workspace</strong>
        <span class="flex items-center gap-2">
          <span class="inline-block w-2 h-2 rounded-full ${this.dot(p.pi.ok)}"></span>
          pi
        </span>
        <span class="flex items-center gap-2">
          <span class="inline-block w-2 h-2 rounded-full ${this.dot(p.confluence.configured)}"></span>
          confluence
        </span>
        <span class="text-zinc-400">skills: ${p.skills.count}</span>
        ${p.confluence.error
          ? html`<span class="text-amber-400 truncate max-w-md" title=${p.confluence.error}>${p.confluence.error}</span>`
          : null}
      </header>
    `
  }
}
