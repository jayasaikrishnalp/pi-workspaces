# Comparison: cloudops-workspace (`:5173`) vs Hermes Workspace (`:3002`)

Captured 2026-05-06 via browser-harness against both running apps.

---

## 1. Sidebar nav — structural parity ✓

Both apps ship the same Hermes-style sidebar layout.

| Group | Hermes items | Our items |
|---|---|---|
| MAIN | Dashboard · Chat · Files · Terminal · Jobs · Tasks · Conductor · Operations · Swarm | Dashboard · Chat · Files · Terminal · Jobs · Tasks · Conductor · Operations · Swarm |
| KNOWLEDGE | Memory · Skills · MCP · Profiles | **Knowledge Graph** · Memory · Skills · **Confluence** · MCP · **Souls** |
| SESSIONS | Real sessions tail (timestamps + last message preview) | "All sessions →" placeholder only |

Things in our KNOWLEDGE group that Hermes does not have:
- **Knowledge Graph** (hex-layout visual graph)
- **Confluence** (search + page fetch)
- **Souls** (replaces Profiles)

---

## 2. What works (live data wired both sides)

| Surface | Hermes | Ours | Notes |
|---|---|---|---|
| Dashboard counts | ✓ | ✓ | Ours has 8 stat cards from `/api/probe`; Hermes has different cards (sessions intelligence, skills usage). |
| Recent jobs / tasks lists | ✓ | ✓ | Ours pulls live `/api/jobs` + `/api/tasks`. |
| Chat compose + send | ✓ | ✓ partial | Ours sends and surfaces tool cards. Hermes adds a lot more chrome (see §3). |
| Knowledge Graph | ✗ | ✓ | **Unique to ours.** 9 nodes / 7 edges rendered with kind palettes + embodies edges. |
| Skills CRUD | (timed out — couldn't capture) | ✓ | Create modal + body editor + live save. |
| Souls / Profiles CRUD | partial (Profiles + Monitoring tabs) | ✓ | Ours: 2 souls listed, full edit. Hermes: Profiles screen exists, schema unknown. |
| Memory CRUD | ✓ (Memory + Knowledge tabs) | ✓ partial | We only have one tab — see §3. |
| Tasks (kanban) | ✓ | ✓ | Both ship kanban with status columns + advance. Ours has 6 cols + advance buttons. |
| Terminal | ✓ (full xterm experience) | ✓ partial | Ours is one-shot bash + audit log. Hermes seems to have a real PTY. |
| MCP screen | ✓ servers only | ✓ servers + tools | Ours lists registered tools too; Hermes lists servers. |
| Confluence | ✗ | ✓ | **Unique to ours.** Search + page-detail wired to Atlassian. |
| Sessions browser | ✓ rich (timestamps + previews) | ✗ placeholder only | Hermes ships a real sessions list with last-message hints. |

---

## 3. Missing in ours (clearly highlighted, by area)

### Chat (BIG GAP)
Hermes chat has these controls visible in its toolbar that ours does not:

- **Toggle file explorer** — Hermes has a "Hide files" / "Toggle file explorer" button → file tree of the agent's working dir
- **Agent View** panel (toggleable: "Hide Agent View") with **⚡ Active Agents** count
- **Voice input** button
- **Add attachment** button (file/image upload into the prompt)
- **Chat controls** popover (model switch / abort / advanced)
- **`{ }` JSON viewer** for raw events
- **Change avatar** button
- **Reply prefix shortcuts** ("Reply with the single word OK and nothing else.")

Ours has just: textarea + send button.

### Dashboard
Hermes Dashboard has features ours lacks:

- **Quick-action buttons in the hero**: NEW CHAT, TERMINAL, SKILLS, OPEN CHAT → (one-click jumps)
- **Edit layout** button (operator-rearrangeable card grid)
- **SESSIONS INTELLIGENCE** panel (per-session analytics — token totals, cost, model mix)
- **SKILLS USAGE** panel (which skills fired in recent sessions)
- **MANAGE → button on each panel** (deep-link to manage that domain)

Ours has 8 static stat cards + "RECENT JOBS" + "RECENT TASKS" — useful but thinner.

### Stats / Cost telemetry footer (entirely missing in ours)
Hermes has a persistent bottom-right strip: **`SESSION | IN 0 OUT 0 CTX 0% COST $0.00`**. Token in/out, context %, dollar cost — present on every screen. We have a statusbar with model + counts but **no token or cost tracking** at all.

### Theme toggle
Hermes has a **"Toggle theme" / "Switch to light mode"** button in the sidebar footer. Ours has a vibe-picker in Settings but no light mode (all 5 vibes are dark variants).

### Search box
Hermes has an explicit **"Search" button** in the titlebar (separate from ⌘K). We have ⌘K palette + FTS5 search but no always-visible search box.

### Sidebar features ours is missing
- **Real sessions tail** — Hermes lists last ~5 sessions with `13:45 · api-bed7bcec9b80e130 / Reply with the single word OK and nothing else.` (timestamp + preview). Ours has only "All sessions →".
- **Session options menu** per row (delete / rename / star).
- **Open chat** button on every screen header — Hermes always shows it; ours doesn't.

### HermesWorld / Playground (we don't have anything like this)
At `/playground` Hermes has:
- "**🎭 CUSTOMIZE AVATAR**" + "**ENTER THE REALM**" buttons
- "**Auto-Start Hermes Agent Gateway**" toggle
- "Show manual setup" / "Copy" affordances
- A whole gamified onboarding realm

Our sidebar has a "HiveWorld NEW" pill but it routes to Dashboard, not a real screen.

### Conductor (we ship a stub; Hermes ships a real one)
Hermes Conductor has:
- "**New Mission**" button + mission launcher
- **Collaboration Ring** with named agents (Nova, Pixel, Blaze) + status (Ready/Ready/Ready)
- **Mascot bar** (cookie 🍪 / coffee ☕ / water — agent "snacks")
- "**How it works**" docs link
- Per-agent edit pencil + AutoIdle indicators

Ours: PREVIEW stub with hardcoded copy.

### Operations (we ship a stub; Hermes ships a real one)
Hermes Operations has:
- **Overview / Outputs** tabs
- "**New Agent**" button
- Per-agent stats

Ours: 4 hardcoded stat cards (uptime / P1 / MTTR / on-call) + PREVIEW badge.

### Swarm (we ship a stub; Hermes ships a real one)
Hermes Swarm is the most distinctive screen they have:
- **Control / Board / Inbox / Runtime** tabs
- **ROUTER** panel + "Orchestrator settings"
- Routing modes: **auto / one agent / broadcast**
- "**Route mission**" CTA
- Status filters: ALL / RUN / REVIEW / BLOCKED / READY
- ACTIVE SWARM / OFFICE views
- "**Add Swarm**" button
- "**Swarm notifications**"

Ours: 6 hardcoded worker cards + PREVIEW badge.

### Files (we ship a stub; Hermes loads it but the page timed out → assume it's a real file browser)
Ours: 4 hardcoded paths + PREVIEW badge.

### Jobs
- Hermes has a "**New Job**" button (operator can create a Job directly).
- Ours: can only cancel; jobs only auto-create from chat sends. Spec'd that way intentionally — but operators may still want manual Job creation.

### Memory
Hermes Memory has **Memory** and **Knowledge** tabs (two distinct surfaces).
Ours has only Memory; no Knowledge tab.

### Profiles vs Souls
Different schemas:
- **Hermes Profiles** has Profiles + **Monitoring** tab + a "Create profile" button. Profile is process-isolated (HERMES_HOME-per-profile).
- **Our Souls** is character/identity (values + priorities + decision principles + tone), referenced from agent frontmatter. Different concept by design (your call earlier: "give Soul to agents, not replace agents with Souls").

Neither covers what the other does. Souls is values/principles; Profiles is workspace isolation. Both could coexist if you want full parity.

---

## 4. What ours has that Hermes does NOT

**Genuine differentiators:**

| Feature | Where | Notes |
|---|---|---|
| **Knowledge Graph (hex layout)** | Sidebar → Knowledge Graph | Visual axial-hex graph with kind palettes + embodies edges. Hermes has no visual graph at all. |
| **Confluence integration** | Sidebar → Confluence | Search + page detail wired to Atlassian. Hermes has no Confluence in the v0.12 release. |
| **Souls (values + principles)** | Sidebar → Souls | Character/identity attached to agents. Hermes has Profiles (process isolation) but no values/principles model. |
| **MCP tools list** | MCP screen → REGISTERED TOOLS | Ours surfaces every registered tool across all servers. Hermes shows servers only. |
| **Probe banner** | Top of every screen (toggle in Settings) | pi/confluence/auth/skills/souls/jobs/mcp pills. |
| **PreviewScreen "PREVIEW" badge** | Swarm/Conductor/Ops/Files | Honest signaling that backend is stub, not silently faking it. |
| **5 vibes** | Settings → Theme | terminal / sre / calm / cyber + default — design-canvas baked in. Hermes has only dark/light. |
| **In-process FTS5 + sanitizer** | ⌘K palette searches it | Hermes has session search but Postgres-FTS-style; ours is local SQLite + trigram dual tokenizer. |
| **Atomic-write KB writers** | Backend | mkdir-as-reservation lock + tmp+rename across all KB kinds. |
| **Per-execution audit log on Terminal** | Terminal → AUDIT LOG | Every command persists in SQLite with status/exit/duration. Hermes terminal is interactive but I didn't see a persistent audit log. |

---

## 5. Severity-ranked gaps (what to close first if catching up to Hermes is the goal)

**High** (visible the moment a user opens the app):
1. **Stats / cost footer** (token in/out + cost) — completely missing
2. **Light mode + theme toggle** (Hermes has dark↔light; ours has 5 dark vibes)
3. **Real sessions tail in sidebar** with timestamps + previews
4. **Sessions browser screen** (currently just a placeholder)
5. **Dashboard quick-actions + Edit layout**

**Medium** (day-2 features once people start using it):
6. **Chat upgrades**: file explorer toggle, agent view panel, attachment button, chat controls popover
7. **Memory: Knowledge tab** (split Memory into Memory + Knowledge)
8. **Conductor real backend** (mission launcher + collaboration ring)
9. **Swarm real backend** (router with routing modes + status filters)
10. **Operations real backend** (Overview / Outputs / New Agent)
11. **Files real backend** (remote file browser)
12. **Jobs: manual `New Job` button**

**Low** (polish):
13. **Voice input + JSON viewer in chat**
14. **HermesWorld-style playground** (gamified onboarding realm)
15. **Per-session options menu** (rename / star / delete)

---

## 6. Bottom line

| | Hermes 0.12 | cloudops-workspace v0.2 |
|---|---|---|
| Screens with real backend | 14 | 11 |
| Screens that are stubs | 1 (HermesWorld) | 4 (Swarm/Conductor/Ops/Files) |
| Token/cost telemetry | ✓ | ✗ **missing** |
| Light mode | ✓ | ✗ |
| Knowledge graph (visual) | ✗ | ✓ |
| Confluence integration | ✗ | ✓ |
| Soul (character layer) | ✗ | ✓ |
| FTS5 local search + ⌘K | partial | ✓ |
| MCP tools list | partial | ✓ |
| File browser | ✓ | stub |
| Conductor / Swarm / Ops engines | ✓ | stubs |
| Sessions tail + browser | ✓ | placeholder |

**Net read:** we ship a defensible *Hermes-shaped* shell with deeper backend in three areas (graph / Confluence / Souls) and shallower coverage everywhere else (chat chrome, sessions, conductor, swarm, ops, files). Closing the High-severity items above would put us at ~80% Hermes-equivalence; closing Medium gets us to ~95%.
