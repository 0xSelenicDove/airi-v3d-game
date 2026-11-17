import { describe, expect, it } from 'vitest'
import { Agent, PERSONAL_SPACE, WALK_SPEED } from '../src/agent'
import { Social } from '../src/social'
import { World, dist } from '../src/world'
import type { Affordance, Brain, Vec2, WorldObject } from '../src/types'

const brain: Brain = { decide: async () => ({ type: 'wait', minutes: 600 }) }
const persona = (name: string, bed: string) => ({ name, description: '', color: 0, sleepWindow: [0, 8] as [number, number], bed })
const look: Affordance = { verb: 'look_around', duration: 600, effects: {}, pose: 'stand' }

/** a spot to walk to, standing at `p` and facing +x */
const spot = (id: string, p: Vec2): WorldObject => ({ id, kind: 'spot', pos: { x: p.x + 1, z: p.z }, usePos: p, affordances: [look] })

/** send an agent walking to `obj` the same way the brain would */
function walk(a: Agent, obj: WorldObject, aff = obj.affordances[0]) {
  a.state = { k: 'idle' }
  ;(a as unknown as { apply(x: unknown): void }).apply({ type: 'interact', object: obj.id, verb: aff.verb })
}

/** start x and z of a straight east-west corridor, 4 m long, with free ground 1 m to each side */
function corridor(w: World): { x: number; z: number } {
  const { x0, z0 } = w.area
  for (let z = z0 + 1.5; z < z0 + 60; z += 0.2) {
    for (let x = x0 + 1; x < x0 + 60; x += 0.5) {
      if ([-1, 0, 1].every(o => w.clearLine({ x, z: z + o }, { x: x + 4, z: z + o }))) return { x, z }
    }
  }
  throw new Error('no free corridor')
}

function setup(rand = () => 0.99) {
  const w = new World()
  w.minutes = 13 * 60
  const a = new Agent(persona('Airi', 'bed'), { x: 0, z: 0 }, brain, w)
  const b = new Agent(persona('Luna', 'bed2'), { x: 0, z: 0 }, brain, w)
  const social = new Social(w, [a, b], rand)
  return { w, a, b, social }
}

/** step both agents (and the meetings) until `done`, recording their closest distance while both stand */
function run(w: World, agents: Agent[], social: Social | null, done: () => boolean, max = 3000) {
  let closest = Infinity, n = 0
  while (!done() && n++ < max) {
    agents.forEach(x => x.tick(0.05, 0.2))
    social?.update(0.05)
    if (agents.length === 2 && agents.every(x => x.pose === 'stand')) closest = Math.min(closest, dist(agents[0].pos, agents[1].pos))
  }
  return { closest, steps: n }
}

describe('walking', () => {
  it('walks at a relaxed pace', () => {
    const { w, a } = setup()
    const { x, z } = corridor(w)
    a.pos = { x, z }
    const goal = spot('g', { x: x + 4, z })
    w.objects.push(goal)
    walk(a, goal)
    const { steps } = run(w, [a], null, () => a.state.k === 'doing')
    expect(a.state.k).toBe('doing')
    expect(steps * 0.05).toBeGreaterThanOrEqual(4 / WALK_SPEED - 0.1) // 4 m at no more than WALK_SPEED
  })

  it('two people walking head-on pass each other without touching', () => {
    const { w, a, b } = setup()
    const { x, z } = corridor(w)
    a.pos = { x, z }; b.pos = { x: x + 4, z }
    const ga = spot('ga', { x: x + 4, z }), gb = spot('gb', { x, z })
    w.objects.push(ga, gb)
    walk(a, ga); walk(b, gb)
    const { closest } = run(w, [a, b], null, () => a.state.k === 'doing' && b.state.k === 'doing')
    expect(a.state.k).toBe('doing')
    expect(b.state.k).toBe('doing')
    expect(closest).toBeGreaterThanOrEqual(PERSONAL_SPACE * 0.95)
  })

  it('someone already standing at a spot makes the next one stand beside them', () => {
    const { w, a, b } = setup()
    const { x, z } = corridor(w)
    const shelf = spot('shelf', { x: x + 2, z })
    w.objects.push(shelf)
    a.pos = { x: x + 0.5, z }; b.pos = { x: x + 3.5, z }
    walk(a, shelf)
    run(w, [a], null, () => a.state.k === 'doing')
    walk(b, shelf)
    run(w, [a, b], null, () => b.state.k === 'doing')
    expect(b.state.k).toBe('doing')
    expect(dist(a.pos, b.pos)).toBeGreaterThanOrEqual(PERSONAL_SPACE)
  })
})

describe('chance meetings', () => {
  it('two walkers who meet may stop, chat, and then carry on to where they were going', () => {
    const { w, a, b, social } = setup(() => 0.1) // 0.1: always the long chat
    const { x, z } = corridor(w)
    a.pos = { x, z }; b.pos = { x: x + 4, z }
    const ga = spot('ga', { x: x + 4, z }), gb = spot('gb', { x, z })
    w.objects.push(ga, gb)
    walk(a, ga); walk(b, gb)
    const said: string[] = []
    a.onSay = t => said.push(`Airi: ${t}`)
    b.onSay = t => said.push(`Luna: ${t}`)
    run(w, [a, b], social, () => a.state.k === 'chatting', 400)
    expect(a.state.k).toBe('chatting')
    expect(b.state.k).toBe('chatting')
    const { closest } = run(w, [a, b], social, () => a.state.k === 'doing' && b.state.k === 'doing')
    expect(said.length).toBeGreaterThanOrEqual(5) // greeting, answer, a question and answer, goodbyes
    expect(said[0].startsWith('Airi') || said[0].startsWith('Luna')).toBe(true)
    expect(a.state.k).toBe('doing')
    expect(b.state.k).toBe('doing')
    expect(closest).toBeGreaterThanOrEqual(PERSONAL_SPACE * 0.95)
    // each remembers the other's words
    expect(a.memory.some(m => m.includes('heard Luna say'))).toBe(true)
  })

  it('the same two do not stop to chat again right away', () => {
    const { w, a, b, social } = setup(() => 0.1)
    const { x, z } = corridor(w)
    const ga = spot('ga', { x: x + 4, z }), gb = spot('gb', { x, z })
    w.objects.push(ga, gb)
    a.pos = { x, z }; b.pos = { x: x + 4, z }
    walk(a, ga); walk(b, gb)
    run(w, [a, b], social, () => a.state.k === 'doing' && b.state.k === 'doing')
    // walk back the other way at once
    walk(a, gb); walk(b, ga)
    let chatted = false
    run(w, [a, b], social, () => { chatted ||= a.state.k === 'chatting'; return a.state.k === 'doing' && b.state.k === 'doing' })
    expect(chatted).toBe(false)
  })
})
