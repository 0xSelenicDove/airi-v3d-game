import { describe, expect, it } from 'vitest'
import { Agent } from '../src/agent'
import { World } from '../src/world'
import type { Brain } from '../src/types'

const brain: Brain = { decide: async () => ({ type: 'wait', minutes: 600 }) }
const persona = { name: 'Airi', description: '', color: 0, sleepWindow: [0, 8] as [number, number], bed: 'bed' }

/** run the agent until `done` holds, in 0.05 s steps; returns the number of steps */
function run(a: Agent, done: () => boolean, max = 4000) {
  let n = 0
  while (!done() && n++ < max) a.tick(0.05, 0.2)
  return n
}

describe('lake', () => {
  it('knows water from land and from the pier', () => {
    const w = new World()
    expect(w.inWater({ x: 19, z: 7 })).toBe(true)
    expect(w.inWater({ x: 23, z: 5 })).toBe(false) // on the pier
    expect(w.inWater({ x: 25, z: 8 })).toBe(true)  // beyond its end
    expect(w.inWater({ x: w.boat.x, z: w.boat.z })).toBe(false) // in the moored boat
    expect(w.inWater({ x: 10, z: 7 })).toBe(false) // on land
  })

  it('an agent walks to the shore, swims laps in the water, and comes out again', () => {
    const w = new World()
    w.minutes = 13 * 60 // swimming is a daytime activity
    const a = new Agent(persona, { x: 15.2, z: 6.8 }, brain, w)
    a.state = { k: 'idle' }
    ;(a as unknown as { apply(x: unknown): void }).apply({ type: 'interact', object: 'swim_1', verb: 'swim' })
    run(a, () => a.state.k === 'doing')
    expect(a.pose).toBe('swim')
    const seen: boolean[] = []
    for (let i = 0; i < 300; i++) { a.tick(0.05, 0.05); seen.push(w.inWater(a.pos)) }
    expect(seen.every(Boolean)).toBe(true) // the laps stay in the lake
    // swim on until it is over, then head back to the shore (the bed, via the door, is far; we only need to be out of the water)
    run(a, () => a.state.k !== 'doing')
    ;(a as unknown as { apply(x: unknown): void }).apply({ type: 'interact', object: 'lawn', verb: 'enjoy_fresh_air' })
    run(a, () => !w.inWater(a.pos), 600)
    expect(a.pose === 'swim' || !w.inWater(a.pos)).toBe(true)
    run(a, () => a.state.k === 'doing')
    expect(a.pose).toBe('stand')
  })
})

describe('rowboat', () => {
  it('rows one lap and ends back at the mooring', () => {
    const w = new World()
    w.minutes = 13 * 60
    const a = new Agent(persona, { x: 23, z: 6.4 }, brain, w)
    a.state = { k: 'idle' }
    const boat = w.find('rowboat')!
    ;(a as unknown as { apply(x: unknown): void }).apply({ type: 'interact', object: 'rowboat', verb: 'boat' })
    run(a, () => a.state.k === 'doing')
    expect(a.pose).toBe('sit') // it never swims on the way into the boat
    let farthest = 0
    for (let i = 0; i < 20000 && a.state.k === 'doing'; i++) {
      a.tick(0.05, 0.5)
      farthest = Math.max(farthest, Math.hypot(a.pos.x - boat.usePos.x, a.pos.z - boat.usePos.z))
    }
    expect(a.state.k).not.toBe('doing')
    expect(farthest).toBeGreaterThan(2.5) // it went round the loop (the ellipse is 3.2 m wide)
    expect(Math.hypot(a.pos.x - boat.usePos.x, a.pos.z - boat.usePos.z)).toBeLessThan(0.01) // and came back
    expect(a.needs.fun).toBeGreaterThan(60)
  })
})
