import { describe, expect, it } from 'vitest'
import { Drift, FidgetPicker, STYLE_RANGE, seeded, styleFor, type MotionStyle } from '../src/motion-style'

describe('motion style', () => {
  it('gives each person a style of their own, the same every time, within the ranges', () => {
    const a = styleFor('Airi'), b = styleFor('Luna')
    expect(styleFor('Airi')).toEqual(a)
    expect(a).not.toEqual(b)
    for (const s of [a, b]) {
      for (const [key, [lo, hi]] of Object.entries(STYLE_RANGE)) {
        const v = s[key as keyof MotionStyle]
        expect(v, key).toBeGreaterThanOrEqual(lo)
        expect(v, key).toBeLessThanOrEqual(hi)
      }
    }
  })

  it('drifts smoothly between -1 and 1, without jumps', () => {
    const d = new Drift(seeded(7), 0.2)
    let prev = d.at(0)
    for (let t = 0.05; t < 120; t += 0.05) {
      const v = d.at(t)
      expect(Math.abs(v)).toBeLessThanOrEqual(1)
      expect(Math.abs(v - prev)).toBeLessThan(0.1)
      prev = v
    }
  })

  it('plays an idle movement every few seconds, never the same one twice in a row', () => {
    const f = new FidgetPicker(seeded(3))
    const kinds: string[] = []
    let last: string | null = null
    for (let t = 0; t < 600; t += 0.1) {
      const now = f.update(t)
      if (now && now.kind !== last) { kinds.push(now.kind); last = now.kind }
      if (!now) last = null
    }
    expect(kinds.length).toBeGreaterThan(40)
    for (let i = 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1])
    expect(new Set(kinds).size).toBe(5)
  })
})
