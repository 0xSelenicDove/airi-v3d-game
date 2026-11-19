import { describe, expect, it } from 'vitest'
import type * as THREE from 'three'
import { AdaptiveResolution } from '../src/resolution'

/** a renderer that only remembers its pixel ratio */
const fake = () => {
  const r = { ratio: 0, setPixelRatio(v: number) { r.ratio = v } }
  return r
}
const frames = (res: AdaptiveResolution, ms: number, seconds: number) => {
  for (let t = 0; t < seconds * 1000; t += ms) res.update(ms)
}

describe('AdaptiveResolution', () => {
  it('starts at the highest ratio and keeps it while frames are fast', () => {
    const r = fake(), res = new AdaptiveResolution(r as unknown as THREE.WebGLRenderer, 1.5)
    expect(r.ratio).toBe(1.5)
    frames(res, 10, 10)
    expect(res.ratio).toBe(1.5)
  })

  it('steps down while frames stay slow, but not below 0.75', () => {
    const r = fake(), res = new AdaptiveResolution(r as unknown as THREE.WebGLRenderer, 1.5)
    frames(res, 40, 3)
    expect(res.ratio).toBeLessThan(1.5)
    frames(res, 40, 30)
    expect(res.ratio).toBe(0.75)
    expect(r.ratio).toBe(0.75)
  })

  it('steps back up once there is room, and settles between the limits', () => {
    const r = fake(), res = new AdaptiveResolution(r as unknown as THREE.WebGLRenderer, 1.5)
    frames(res, 40, 30)
    frames(res, 10, 30)
    expect(res.ratio).toBe(1.5)
    // a frame time between the two limits changes nothing
    const before = res.ratio
    frames(res, 18, 20)
    expect(res.ratio).toBe(before)
  })

  it('ignores hitches such as a model loading', () => {
    const r = fake(), res = new AdaptiveResolution(r as unknown as THREE.WebGLRenderer, 1.5)
    for (let i = 0; i < 50; i++) res.update(700)
    expect(res.ratio).toBe(1.5)
  })
})
