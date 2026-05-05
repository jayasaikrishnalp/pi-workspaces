import { LitElement, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'

@customElement('skills-sidebar')
export class SkillsSidebar extends LitElement {
  createRenderRoot() { return this }

  @property({ attribute: false }) skills: Array<{ id: string; description?: string }> = []

  render() {
    return html`
      <aside class="w-64 shrink-0 overflow-y-auto border-r border-zinc-800 p-3 space-y-1 text-sm">
        <h2 class="px-2 py-1 text-xs uppercase tracking-wider text-zinc-500">Skills (${this.skills.length})</h2>
        ${this.skills.length === 0
          ? html`<p class="px-2 text-zinc-500">No skills yet. Save a Confluence answer as a skill to start the loop.</p>`
          : this.skills.map(
              (s) => html`
                <a
                  href="#/skill/${encodeURIComponent(s.id)}"
                  class="block px-2 py-1.5 rounded hover:bg-zinc-800 cursor-pointer"
                  title=${s.description ?? ''}
                >
                  <div class="text-zinc-100">${s.id}</div>
                  ${s.description
                    ? html`<div class="text-xs text-zinc-500 truncate">${s.description}</div>`
                    : null}
                </a>
              `,
            )}
      </aside>
    `
  }
}
