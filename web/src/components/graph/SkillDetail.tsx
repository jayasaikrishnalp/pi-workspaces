import { useEffect, useState } from 'react'

import { getKbSkill, type KbDetail, type SkillEdge, type SkillNode } from '../../lib/api'

interface Props {
  node: SkillNode | null
  edges: SkillEdge[]
  onClose: () => void
  onSelectName: (name: string) => void
}

export function SkillDetail({ node, edges, onClose, onSelectName }: Props): JSX.Element | null {
  const [detail, setDetail] = useState<KbDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setDetail(null); setError(null)
    if (!node) return
    if (node.source !== 'skill') {
      // Skill-detail endpoint only exists for skills today; agents/workflows/
      // souls land in phase 5 with their own detail endpoints.
      return
    }
    let cancelled = false
    setLoading(true)
    getKbSkill(node.name)
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [node?.name])

  if (!node) return null

  const incoming = edges.filter((e) => e.target === node.name)
  const outgoing = edges.filter((e) => e.source === node.name)

  return (
    <div className="skill-detail" data-testid="skill-detail" data-node={node.name}>
      <div className="skill-detail-head">
        <div className="skill-detail-source">{node.source}</div>
        <h3 data-testid="skill-detail-name">{node.name}</h3>
        <button className="btn btn-ghost skill-detail-close" onClick={onClose} aria-label="Close" data-testid="skill-detail-close">×</button>
      </div>
      {node.description ? <p className="skill-detail-desc">{node.description}</p> : null}
      <div className="skill-detail-path">
        <span className="kk-label-tiny">PATH</span>
        <code>{node.path}</code>
      </div>

      {node.source === 'skill' ? (
        <div className="skill-detail-body" data-testid="skill-detail-body">
          {loading ? <div className="dash-empty">loading…</div>
            : error ? <div className="chat-msg-error">{error}</div>
            : detail ? (
              <pre className="tool-card-pre">{detail.body || '(empty)'}</pre>
            ) : null}
        </div>
      ) : (
        <div className="dash-empty" data-testid="skill-detail-not-loaded">
          Detail endpoint for {node.source}s lands in phase 5.
        </div>
      )}

      {(incoming.length > 0 || outgoing.length > 0) ? (
        <div className="skill-detail-edges">
          <span className="kk-label-tiny">EDGES</span>
          {outgoing.map((e, i) => (
            <button key={`out-${i}`} className="skill-edge-link" onClick={() => onSelectName(e.target)} data-testid={`edge-out-${e.target}`}>
              <span className="skill-edge-kind">{e.kind} →</span>
              <span className="skill-edge-name">{e.target}</span>
            </button>
          ))}
          {incoming.map((e, i) => (
            <button key={`in-${i}`} className="skill-edge-link" onClick={() => onSelectName(e.source)} data-testid={`edge-in-${e.source}`}>
              <span className="skill-edge-kind">← {e.kind}</span>
              <span className="skill-edge-name">{e.source}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
