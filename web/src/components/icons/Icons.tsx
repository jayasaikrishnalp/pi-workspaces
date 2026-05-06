/**
 * Icon set lifted in spirit from the v2 design's icons.jsx — reduced to what
 * Phase 1 needs. We add icons phase-by-phase as screens land.
 */

import type { CSSProperties } from 'react'

interface Props { size?: number; className?: string; style?: CSSProperties }
const stroke = 1.6
const def = (size: number) => ({
  width: size, height: size, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', strokeWidth: stroke,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
})

export const Icons = {
  dashboard: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
  ),
  chat: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><path d="M21 15a4 4 0 0 1-4 4H8l-5 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>
  ),
  files: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
  ),
  terminal: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
  ),
  jobs: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
  ),
  tasks: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
  ),
  conductor: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><path d="M5 21l7-10 7 10"/></svg>
  ),
  ops: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
  ),
  swarm: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/></svg>
  ),
  graph: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/></svg>
  ),
  memory: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v0A2.5 2.5 0 0 1 14.5 2A2.5 2.5 0 0 1 17 4.5v15a2.5 2.5 0 0 1-5 0v0a2.5 2.5 0 0 1-5 0v-15A2.5 2.5 0 0 1 9.5 2z"/></svg>
  ),
  book: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
  ),
  search: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
  ),
  mcp: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
  ),
  profiles: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
  ),
  history: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
  ),
  plus: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
  ),
  chev: ({ size = 12, ...p }: Props) => (
    <svg {...def(size)} {...p}><polyline points="6 9 12 15 18 9"/></svg>
  ),
  settings: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
  ),
  bell: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
  ),
  question: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
  ),
  spark: ({ size = 16, ...p }: Props) => (
    <svg {...def(size)} {...p}><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
  ),
}

export function Logo({ size = 18 }: { size?: number }): JSX.Element {
  // π glyph instead of the kodekloud bee — matches the chat's "rebrand to Hive"
  // ask while keeping the kodekloud accent gradient.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Hive">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--logo-stop-1, #A5FECB)"/>
          <stop offset="0.5" stopColor="var(--logo-stop-2, #12D8FA)"/>
          <stop offset="1" stopColor="var(--logo-stop-3, #1FA2FF)"/>
        </linearGradient>
      </defs>
      <text x="12" y="18" textAnchor="middle" fontFamily="var(--font-mono, monospace)" fontWeight="700" fontSize="18" fill="url(#lg)">π</text>
    </svg>
  )
}
