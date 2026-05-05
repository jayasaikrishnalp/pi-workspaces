import { LitElement, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import * as d3 from 'd3-force'
import { select } from 'd3-selection'
import { drag } from 'd3-drag'
import { zoom } from 'd3-zoom'

interface GraphNode extends d3.SimulationNodeDatum {
  id: string
  label: string
  description?: string
}
interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  kind: 'uses' | 'link'
}

@customElement('kb-graph')
export class KbGraph extends LitElement {
  createRenderRoot() { return this }

  @property({ attribute: false }) nodes: Array<{ id: string; description?: string }> = []
  @property({ attribute: false }) edges: Array<{ source: string; target: string; kind: 'uses' | 'link' }> = []

  private sim: d3.Simulation<GraphNode, GraphLink> | null = null
  private svg: SVGSVGElement | null = null
  private container: SVGGElement | null = null

  connectedCallback() {
    super.connectedCallback()
    queueMicrotask(() => this.mountGraph())
  }
  disconnectedCallback() {
    super.disconnectedCallback()
    this.sim?.stop()
  }

  protected updated(changed: Map<string, unknown>) {
    if ((changed.has('nodes') || changed.has('edges')) && this.svg) this.refresh()
  }

  private mountGraph() {
    const root = this.querySelector('#kb-graph-root') as HTMLDivElement | null
    if (!root) return
    const w = root.clientWidth || 800
    const h = root.clientHeight || 600
    const svg = select(root).append('svg')
      .attr('width', w)
      .attr('height', h)
      .attr('viewBox', `0 0 ${w} ${h}`)
      .style('background', '#0a0a0b')

    const g = svg.append('g')
    svg.call(
      zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.25, 4])
        .on('zoom', (e) => g.attr('transform', e.transform.toString())),
    )

    this.svg = svg.node() as SVGSVGElement
    this.container = g.node() as SVGGElement
    this.refresh()
  }

  private refresh() {
    if (!this.container || !this.svg) return
    const g = select(this.container)
    g.selectAll('*').remove()

    const nodes: GraphNode[] = this.nodes.map((n) => ({
      id: n.id,
      label: n.id,
      description: n.description,
    }))
    const ids = new Set(nodes.map((n) => n.id))
    const links: GraphLink[] = this.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, kind: e.kind }))

    const w = this.svg.clientWidth || 800
    const h = this.svg.clientHeight || 600

    const sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance(90))
      .force('charge', d3.forceManyBody().strength(-260))
      .force('center', d3.forceCenter(w / 2, h / 2))
      .force('collide', d3.forceCollide(28))
    this.sim = sim

    const link = g.append('g')
      .attr('stroke', '#3f3f46')
      .selectAll<SVGLineElement, GraphLink>('line')
      .data(links)
      .join('line')
      .attr('stroke-width', (d) => (d.kind === 'uses' ? 2 : 1))
      .attr('stroke-dasharray', (d) => (d.kind === 'link' ? '4 3' : null))

    const node = g.append('g')
      .selectAll<SVGGElement, GraphNode>('g')
      .data(nodes)
      .join('g')
      .style('cursor', 'pointer')
      .on('click', (_e, d) => {
        location.hash = `#/skill/${encodeURIComponent(d.id)}`
      })
      .call(
        drag<SVGGElement, GraphNode>()
          .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
          .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y })
          .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null }),
      )

    node.append('circle')
      .attr('r', 18)
      .attr('fill', '#1e293b')
      .attr('stroke', '#38bdf8')
      .attr('stroke-width', 1.5)

    node.append('text')
      .text((d) => d.label)
      .attr('text-anchor', 'middle')
      .attr('dy', 4)
      .attr('fill', '#e4e4e7')
      .attr('font-size', 11)
      .style('pointer-events', 'none')

    sim.on('tick', () => {
      link
        .attr('x1', (d) => (d.source as GraphNode).x ?? 0)
        .attr('y1', (d) => (d.source as GraphNode).y ?? 0)
        .attr('x2', (d) => (d.target as GraphNode).x ?? 0)
        .attr('y2', (d) => (d.target as GraphNode).y ?? 0)
      node.attr('transform', (d) => `translate(${d.x ?? 0}, ${d.y ?? 0})`)
    })
  }

  render() {
    return html`<div id="kb-graph-root" class="flex-1 h-full"></div>`
  }
}
