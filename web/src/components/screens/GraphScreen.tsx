import { useState, useMemo } from 'react'

import { HexGraph } from '../graph/HexGraph'
import { SkillDetail } from '../graph/SkillDetail'
import { useKbGraph } from '../../hooks/useKbGraph'
import type { SkillNode } from '../../lib/api'

export function GraphScreen(): JSX.Element {
  const { data, loading, error } = useKbGraph()
  const [selected, setSelected] = useState<SkillNode | null>(null)

  const nodesByName = useMemo(() => {
    const m = new Map<string, SkillNode>()
    for (const n of data?.nodes ?? []) m.set(n.name, n)
    return m
  }, [data?.nodes])

  return (
    <div className="graph-screen" data-testid="graph">
      <div className="graph-header">
        <div>
          <h2>Knowledge Graph</h2>
          <div className="graph-subline">
            {data ? `${data.nodes.length} nodes · ${data.edges.length} edges` : loading ? 'loading…' : 'no data'}
          </div>
        </div>
        <div className="graph-legend">
          <span className="legend-item"><span className="legend-dot legend-skill"/>skill</span>
          <span className="legend-item"><span className="legend-dot legend-agent"/>agent</span>
          <span className="legend-item"><span className="legend-dot legend-workflow"/>workflow</span>
          <span className="legend-item"><span className="legend-dot legend-soul"/>soul</span>
        </div>
      </div>
      {error ? <div className="chat-msg-error" data-testid="graph-error">{error.message}</div> : null}
      <div className="graph-body" data-testid="graph-body">
        <div className="graph-canvas">
          {data ? (
            <HexGraph
              nodes={data.nodes}
              edges={data.edges}
              onSelect={setSelected}
              selected={selected}
            />
          ) : null}
        </div>
        {selected ? (
          <SkillDetail
            node={selected}
            edges={data?.edges ?? []}
            onClose={() => setSelected(null)}
            onSelectName={(n) => {
              const found = nodesByName.get(n)
              if (found) setSelected(found)
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
