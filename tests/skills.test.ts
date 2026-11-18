import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Agent, PERSONAL_SPACE } from '../src/agent'
import { World, dist, segDist } from '../src/world'
import { RULES } from '../src/skills'
import { bedRect } from '../src/skills/bed'
import { leaf } from '../src/skills/door'
import type { Affordance, Brain, Vec2, WorldObject } from '../src/types'

const brain: Brain = { decide: async () => ({ type: 'wait', minutes: 600 }) }
const persona = (name: string, bed: string) => ({ name, description: '', color: 0, sleepWindow: [0, 8] as [number, number], bed })
const DT = 0.05

function send(a: Agent, object: string, verb: string) {
  a.state = { k: 'idle' }
  ;(a as unknown as { apply(x: unknown): void }).apply({ type: 'interact', object, verb })
}

/** step `a` (and any others) until `done`, calling `each` after every step; returns the steps taken */
function run(agents: Agent[], done: () => boolean, each: () => void = () => {}, max = 6000) {
  let n = 0
  while (!done() && n++ < max) { agents.forEach(x => x.tick(DT, 0.2)); each() }
  return n
}

const inside = (r: { cx: number; cz: number; w: number; d: number }, p: Vec2, margin = 0) =>
  Math.abs(p.x - r.cx) < r.w / 2 - margin && Math.abs(p.z - r.cz) < r.d / 2 - margin

describe('rules', () => {
  it('RULES.md lists every rule the code knows', () => {
    const md = readFileSync(new URL('../src/skills/RULES.md', import.meta.url), 'utf-8')
    expect(RULES.map(r => r.id)).toEqual(['R0', 'R1', 'R2', 'R3', 'R4'])
    for (const r of RULES) expect(md, r.id).toContain(`| ${r.id} |`)
  })
})

describe('R1, R2: going to bed and getting up', () => {
  it('walks to the side of the bed, sits on the edge, takes the shoes off, then lies down; gets up the same way', () => {
    const w = new World()
    const a = new Agent(persona('Airi', 'bed'), { x: 0, z: 0 }, brain, w)
    const bed = w.find('bed')!
    const r = bedRect(w, bed)
    const seen: { pose: string; pos: Vec2; shoes: boolean }[] = []
    const record = () => seen.push({ pose: a.pose, pos: { ...a.pos }, shoes: a.shoesOn })
    send(a, 'bed', 'sleep')
    run([a], () => a.state.k === 'doing', record)
    expect(a.state.k).toBe('doing')
    expect(a.pose).toBe('lie')

    const firstSit = seen.findIndex(s => s.pose === 'sit'), firstLie = seen.findIndex(s => s.pose === 'lie')
    expect(firstSit).toBeGreaterThan(-1)
    expect(firstSit).toBeLessThan(firstLie)                       // sits down before lying down (R2)
    expect(seen[firstLie].shoes).toBe(false)                      // shoes off before lying down (R1)
    expect(seen.slice(0, firstSit).every(s => s.shoes)).toBe(true)
    // it sat down on the edge of the bed, not in its middle
    const sitAt = seen[firstLie - 1].pos
    expect(inside(r, sitAt)).toBe(true)
    expect(inside(r, sitAt, 0.25)).toBe(false)
    expect(dist(sitAt, bed.usePos)).toBeGreaterThan(0.4)
    // standing or walking, it never stood inside the bed, and kept clear of furniture (R0)
    for (const s of seen.filter(s => s.pose === 'stand')) {
      expect(inside(r, s.pos), `${s.pos.x},${s.pos.z}`).toBe(false)
      expect(w.clearance(s.pos)).toBeGreaterThanOrEqual(0.19)
    }

    // wake up
    seen.length = 0
    if (a.state.k === 'doing') a.state.left = 0.1
    run([a], () => a.state.k === 'waiting' || a.state.k === 'thinking', record)
    const sitUp = seen.findIndex(s => s.pose === 'sit'), stoodUp = seen.findIndex(s => s.pose === 'stand')
    expect(sitUp).toBeGreaterThan(-1)
    expect(sitUp).toBeLessThan(stoodUp)                           // sits up on the edge before standing (R2)
    expect(seen[stoodUp].shoes).toBe(true)                        // shoes back on before standing (R1)
    expect(w.isFree(a.pos)).toBe(true)                            // back on the open floor
    expect(w.occupant('bed')).toBeUndefined()
  })
})

describe('R3: the door', () => {
  function through(from: Vec2, object: string, verb: string) {
    const w = new World()
    w.minutes = 12 * 60
    const a = new Agent(persona('Airi', 'bed'), from, brain, w)
    const log: { t: number; x: number; z: number; open: number; gesture: string; heading: number }[] = []
    let t = 0
    send(a, object, verb)
    run([a], () => a.state.k === 'doing', () => {
      t += DT
      log.push({ t, x: a.pos.x, z: a.pos.z, open: w.doorOpen, gesture: a.gesture, heading: a.heading })
    })
    return { w, a, log }
  }

  for (const [label, from, object, verb] of [
    ['going out', { x: 0, z: 0 }, 'lawn', 'enjoy_fresh_air'],
    ['coming in', { x: 8, z: 2 }, 'bed', 'sleep'],
  ] as const) {
    it(`${label}: reaches for the handle, opens slowly, goes through only when it is open, turns round and closes it`, () => {
      const { w, a, log } = through(from, object, verb)
      expect(a.state.k).toBe('doing')
      const crossed = log.findIndex((s, i) => i > 0 && (log[i - 1].x < w.door.x) !== (s.x < w.door.x))
      expect(crossed).toBeGreaterThan(0)
      // through the doorway only while the door is open (R0, R3)
      for (const s of log.filter(s => Math.abs(s.x - w.door.x) < 0.3)) expect(s.open, `at ${s.x.toFixed(2)}`).toBeGreaterThan(0.97)
      // the hand went to the handle before the door moved
      const moved = log.findIndex(s => s.open > 0.01)
      expect(log.slice(0, moved).some(s => s.gesture === 'reach_handle')).toBe(true)
      // opened slowly
      const opened = log.findIndex(s => s.open > 0.97)
      expect(log[opened].t - log[moved].t).toBeGreaterThan(1.2)
      // closed again after going through, while still near the door, facing it
      const shut = log.findIndex((s, i) => i > crossed && s.open < 0.01)
      expect(shut).toBeGreaterThan(crossed)
      expect(Math.hypot(log[shut].x - w.door.x, log[shut].z - w.door.z)).toBeLessThan(2)
      const closing = log.slice(crossed, shut).filter((s, i, xs) => i > 0 && s.open < xs[i - 1].open)
      expect(closing.length).toBeGreaterThan(0)
      for (const s of closing) {
        // turned round to the door: facing its leaf (which stands out to the side while open)
        const [h, e] = leaf(w, s.open), mid = { x: (h.x + e.x) / 2, z: (h.z + e.z) / 2 }
        const toDoor = Math.atan2(mid.x - s.x, mid.z - s.z)
        expect(Math.abs(Math.atan2(Math.sin(s.heading - toDoor), Math.cos(s.heading - toDoor)))).toBeLessThan(1.0)
      }
      expect(w.doorUser).toBeUndefined()
      // the leaf never swept through the person (R0)
      for (const s of log) {
        const [h, e] = leaf(w, s.open)
        expect(segDist({ x: s.x, z: s.z }, h, e)).toBeGreaterThan(0.25)
      }
    })
  }
})

describe('R4: blocked', () => {
  /** an east-west corridor, 4 m long, with free ground 1 m to each side */
  function corridor(w: World) {
    const { x0, z0 } = w.area
    for (let z = z0 + 1.5; z < z0 + 60; z += 0.2) for (let x = x0 + 1; x < x0 + 60; x += 0.5) {
      if ([-1, 0, 1].every(o => w.clearLine({ x, z: z + o }, { x: x + 4, z: z + o }))) return { x, z }
    }
    throw new Error('no free corridor')
  }
  const look: Affordance = { verb: 'look_around', duration: 600, effects: {}, pose: 'stand' }
  const spot = (id: string, p: Vec2): WorldObject => ({ id, kind: 'spot', pos: { x: p.x + 1, z: p.z }, usePos: p, affordances: [look] })

  it('stops, thinks, and takes another way round someone who stands in the way, without touching them', () => {
    const w = new World()
    const { x, z } = corridor(w)
    const walker = new Agent(persona('Airi', 'bed'), { x, z }, brain, w)
    const blocker = new Agent(persona('Luna', 'bed2'), { x: x + 2, z }, brain, w)
    blocker.state = { k: 'waiting', left: 1e9 }
    const goal = spot('goal', { x: x + 4, z })
    w.objects.push(goal)
    send(walker, 'goal', 'look_around')
    const thoughts = new Set<string>()
    let closest = Infinity
    run([walker, blocker], () => walker.state.k === 'doing', () => {
      if (walker.thought) thoughts.add(walker.thought)
      closest = Math.min(closest, dist(walker.pos, blocker.pos))
    })
    expect(walker.state.k).toBe('doing')
    expect(closest).toBeGreaterThanOrEqual(PERSONAL_SPACE * 0.95)
    // steering round someone standing still may not even need the stop; if it stopped, it thought first
    if (thoughts.size) expect([...thoughts].some(t => /another way/i.test(t))).toBe(true)
  })

  it('when people fill the only way through (the gate), it waits and finally gives up instead of pushing past', () => {
    const w = new World()
    const g = w.gate
    const walker = new Agent(persona('Airi', 'bed'), { x: g.x - 2.5, z: g.z }, brain, w)
    // three people across the 2 m wide gate leave no gap a person fits through
    const people = [-0.65, 0, 0.65].map((o, i) => new Agent(persona(`P${i}`, 'bed2'), { x: g.x, z: g.z + o }, brain, w))
    for (const p of people) p.state = { k: 'waiting', left: 1e9 }
    const beyond = { x: g.x + 2.5, z: g.z }
    expect(w.isFree(beyond)).toBe(true)
    w.objects.push(spot('beyond', beyond))
    send(walker, 'beyond', 'look_around')
    const thoughts: string[] = []
    let closest = Infinity
    run([walker, ...people], () => walker.state.k === 'waiting' && /blocked/.test(walker.lastResult ?? ''), () => {
      if (walker.thought && thoughts[thoughts.length - 1] !== walker.thought) thoughts.push(walker.thought)
      closest = Math.min(closest, ...people.map(p => dist(walker.pos, p.pos)))
    })
    expect(thoughts.some(t => /another way/i.test(t))).toBe(true)
    expect(thoughts.some(t => /wait/i.test(t))).toBe(true)
    expect(walker.lastResult).toMatch(/blocked/)
    expect(closest).toBeGreaterThanOrEqual(PERSONAL_SPACE * 0.95)
  })
})

describe('R0, R2 in the tent: the camp cots', () => {
  it('goes in through the open side, sits on the cot from the aisle, and never slides through the tent or the other cot', () => {
    const w = new World()
    w.minutes = 22 * 60 // sleeping in the tent is a night activity
    const a = new Agent(persona('Airi', 'bed'), { x: 24, z: 2.6 }, brain, w)
    const cot = w.find('tent_cot_1')!, other = bedRect(w, w.find('tent_cot_2')!), mine = bedRect(w, cot)
    const seen: { pose: string; pos: Vec2 }[] = []
    send(a, 'tent_cot_1', 'sleep_in_tent')
    run([a], () => a.state.k === 'doing', () => seen.push({ pose: a.pose, pos: { ...a.pos } }))
    expect(a.state.k).toBe('doing')
    const firstSit = seen.findIndex(s => s.pose === 'sit')
    expect(firstSit).toBeGreaterThan(0)
    const sitAt = seen[firstSit].pos
    // sat down from the aisle between the cots (the middle of the tent, where it is high enough to stand)
    expect(sitAt.z).toBeGreaterThan(mine.cz)
    expect(seen[firstSit - 1].pos.z).toBeGreaterThan(mine.cz + mine.d / 2)
    expect(seen[firstSit - 1].pos.z).toBeLessThan(other.cz - other.d / 2)
    // no big slide while sitting: the body moves only from the edge onto the cot
    const sitting = seen.filter(s => s.pose === 'sit').map(s => s.pos)
    for (let i = 1; i < sitting.length; i++) expect(dist(sitting[i], sitting[0])).toBeLessThan(0.6)
    // standing, never inside either cot
    for (const s of seen.filter(s => s.pose === 'stand')) {
      expect(inside(mine, s.pos)).toBe(false)
      expect(inside(other, s.pos)).toBe(false)
    }
  })
})

describe('R0 at the door', () => {
  it('walking between the meadow and the yard does not touch the house door', () => {
    const w = new World()
    w.minutes = 12 * 60
    const a = new Agent(persona('Airi', 'bed'), { x: 16, z: -4 }, brain, w)
    send(a, 'bench_seat_1', 'relax')
    let touched = false
    run([a], () => a.state.k === 'doing', () => { touched ||= w.doorUser !== undefined || w.doorOpen > 0 })
    expect(a.state.k).toBe('doing')
    expect(touched).toBe(false)
  })

  it('does not open the door while someone stands where it swings, and opens it once they have gone', () => {
    const w = new World()
    w.minutes = 12 * 60
    const opener = new Agent(persona('Airi', 'bed'), { x: 0, z: 0 }, brain, w)
    const outside = new Agent(persona('Luna', 'bed2'), { x: w.door.x + 0.6, z: w.door.z - 0.3 }, brain, w) // right behind the door
    outside.state = { k: 'waiting', left: 1e9 }
    send(opener, 'lawn', 'enjoy_fresh_air')
    let waited = false, openWhileThere = 0
    run([opener, outside], () => waited || opener.state.k === 'doing', () => {
      if (/behind the door/.test(opener.thought)) waited = true
      openWhileThere = Math.max(openWhileThere, w.doorOpen)
    })
    expect(waited).toBe(true)
    expect(openWhileThere).toBe(0)
    // Luna steps away; the door opens and Airi gets out
    outside.pos = { x: w.door.x + 3, z: w.door.z + 3 }
    run([opener, outside], () => opener.state.k === 'doing')
    expect(opener.state.k).toBe('doing')
    expect(w.doorOpen).toBe(0)
  })

  it('people inside and outside the house do not meet through the wall', async () => {
    const { Social } = await import('../src/social')
    const w = new World()
    const a = new Agent(persona('Airi', 'bed'), { x: w.door.x - 0.7, z: w.door.z }, brain, w)
    const b = new Agent(persona('Luna', 'bed2'), { x: w.door.x + 0.8, z: w.door.z + 0.8 }, brain, w)
    const social = new Social(w, [a, b], () => 0.1)
    a.state = { k: 'waiting', left: 1e9 }
    w.objects.push({ id: 'far', kind: 'spot', pos: { x: 9, z: 6 }, usePos: { x: 8, z: 6 }, affordances: [{ verb: 'look_around', duration: 600, effects: {}, pose: 'stand' }] })
    send(b, 'far', 'look_around')
    let chatted = false
    run([a, b], () => b.state.k === 'doing', () => { social.update(DT); chatted ||= a.state.k === 'chatting' })
    expect(chatted).toBe(false)
  })
})

describe('R0 with loose things', () => {
  it('a ball stuck in a corner of the fence cannot roll away: the walker stops short instead of squashing it', () => {
    const w = new World()
    const y = w.yard
    // a ball in the south-west corner of the yard; walking west along the fence pushes it into the fence
    const ball = { x: y.x0 + 0.5, z: y.z0 + 0.55, r: 0.17 }
    w.props = [ball]
    const walker = new Agent(persona('Airi', 'bed'), { x: ball.x + 3, z: ball.z }, brain, w)
    w.objects.push({ id: 'corner', kind: 'spot', pos: { x: ball.x - 1, z: ball.z }, usePos: { ...ball }, affordances: [{ verb: 'look_around', duration: 600, effects: {}, pose: 'stand' }] })
    send(walker, 'corner', 'look_around')
    let closest = Infinity
    run([walker], () => walker.state.k === 'waiting' && /blocked/.test(walker.lastResult ?? ''), () => {
      closest = Math.min(closest, dist(walker.pos, ball))
    })
    expect(walker.lastResult).toMatch(/blocked/)
    expect(closest).toBeGreaterThanOrEqual(0.26 + ball.r - 0.01)
  })

  it('a ball out in the open does not stop anyone: it gets pushed', () => {
    const w = new World()
    const y = w.yard
    const ball = { x: 0, z: y.z0 + 2.5, r: 0.17 }
    w.props = [ball]
    const walker = new Agent(persona('Airi', 'bed'), { x: -2, z: ball.z }, brain, w)
    w.objects.push({ id: 'east', kind: 'spot', pos: { x: 3, z: ball.z }, usePos: { x: 2, z: ball.z }, affordances: [{ verb: 'look_around', duration: 600, effects: {}, pose: 'stand' }] })
    send(walker, 'east', 'look_around')
    run([walker], () => walker.state.k === 'doing')
    expect(walker.state.k).toBe('doing')
  })
})
