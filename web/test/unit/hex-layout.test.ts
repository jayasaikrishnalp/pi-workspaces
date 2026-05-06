/**
 * Unit tests for the axial-coordinate hex layout helpers.
 */

import { describe, it, expect } from 'vitest'

import { hexPos, spiralHex, autoLayout, layoutBounds, COL_OFFSET, ROW_OFFSET, HEX_W, HEX_H } from '../../src/lib/hexLayout'

describe('hexPos', () => {
  it('center at (0,0) is the origin', () => {
    expect(hexPos({ q: 0, r: 0 })).toEqual({ x: 0, y: 0 })
  })

  it('moves COL_OFFSET right per +q on even rows', () => {
    expect(hexPos({ q: 1, r: 0 })).toEqual({ x: COL_OFFSET, y: 0 })
    expect(hexPos({ q: 2, r: 0 })).toEqual({ x: COL_OFFSET * 2, y: 0 })
  })

  it('moves ROW_OFFSET down per +r and offsets x by COL_OFFSET/2 on odd rows', () => {
    expect(hexPos({ q: 0, r: 1 })).toEqual({ x: COL_OFFSET / 2, y: ROW_OFFSET })
    expect(hexPos({ q: 0, r: 2 })).toEqual({ x: 0, y: ROW_OFFSET * 2 })
  })
})

describe('spiralHex', () => {
  it('index 0 returns the center', () => {
    expect(spiralHex(0)).toEqual({ q: 0, r: 0 })
  })

  it('first ring (indices 1..6) returns 6 distinct positions distinct from center', () => {
    const set = new Set<string>()
    for (let i = 1; i <= 6; i++) {
      const { q, r } = spiralHex(i)
      expect(q === 0 && r === 0).toBe(false)
      set.add(`${q},${r}`)
    }
    expect(set.size).toBe(6)
  })

  it('second ring (indices 7..18) yields 12 distinct positions', () => {
    const set = new Set<string>()
    for (let i = 7; i <= 18; i++) {
      const { q, r } = spiralHex(i)
      set.add(`${q},${r}`)
    }
    expect(set.size).toBe(12)
  })

  it('all 19 first-three-ring positions are unique', () => {
    const all = new Set<string>()
    for (let i = 0; i < 19; i++) {
      const { q, r } = spiralHex(i)
      all.add(`${q},${r}`)
    }
    expect(all.size).toBe(19)
  })

  it('is deterministic for the same index', () => {
    expect(spiralHex(15)).toEqual(spiralHex(15))
  })
})

describe('autoLayout', () => {
  type N = { name: string; source: string }

  it('places nodes in spiral order with center at the highest-degree node', () => {
    const nodes: N[] = [
      { name: 'leaf', source: 'skill' },
      { name: 'hub',  source: 'skill' },
      { name: 'mid',  source: 'agent' },
    ]
    const edges = [
      { source: 'hub', target: 'leaf' },
      { source: 'hub', target: 'mid' },
    ]
    const laid = autoLayout({ nodes, edges, keyOf: (n) => n.name, kindOf: (n) => n.source })
    expect(laid[0]!.data.name).toBe('hub')        // highest degree → center
    expect(laid[0]!.q).toBe(0); expect(laid[0]!.r).toBe(0)
    expect(laid).toHaveLength(3)
  })

  it('orders by kind precedence when degrees match (skills before agents before souls)', () => {
    const nodes: N[] = [
      { name: 'a-soul',  source: 'soul' },
      { name: 'a-skill', source: 'skill' },
      { name: 'a-agent', source: 'agent' },
    ]
    const laid = autoLayout({ nodes, edges: [], keyOf: (n) => n.name, kindOf: (n) => n.source })
    expect(laid.map((n) => n.data.name)).toEqual(['a-skill', 'a-agent', 'a-soul'])
  })

  it('falls back to alphabetic order when degree + kind are equal', () => {
    const nodes: N[] = [
      { name: 'zebra', source: 'skill' },
      { name: 'alpha', source: 'skill' },
    ]
    const laid = autoLayout({ nodes, edges: [], keyOf: (n) => n.name, kindOf: (n) => n.source })
    expect(laid[0]!.data.name).toBe('alpha')
  })

  it('returns empty array on empty input', () => {
    const laid = autoLayout({ nodes: [], edges: [], keyOf: (n: N) => n.name, kindOf: (n: N) => n.source })
    expect(laid).toEqual([])
  })
})

describe('layoutBounds', () => {
  it('returns a HEX-sized box for empty input', () => {
    const b = layoutBounds<unknown>([])
    expect(b.width).toBe(HEX_W)
    expect(b.height).toBe(HEX_H)
  })

  it('grows to fit all node positions plus padding', () => {
    const nodes = [
      { data: 'a', q: 0, r: 0, x: 0, y: 0 },
      { data: 'b', q: 0, r: 0, x: 200, y: 0 },
      { data: 'c', q: 0, r: 0, x: 0, y: 100 },
    ]
    const b = layoutBounds(nodes)
    expect(b.width).toBeGreaterThanOrEqual(200 + 2 * HEX_W)
    expect(b.height).toBeGreaterThanOrEqual(100 + 2 * HEX_H)
  })
})
