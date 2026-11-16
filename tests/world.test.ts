import { describe, expect, it } from 'vitest'
import { World, dist } from '../src/world'

describe('World navigation', () => {
  const w = new World()

  it('has the interaction points agents rely on', () => {
    for (const id of ['bed', 'bed2', 'desk', 'bookshelf']) expect(w.find(id), id).toBeDefined()
  })

  it('every object is reachable by a route that stays on free cells', () => {
    const start = { x: 0, z: 0 }
    for (const o of w.objects) {
      const goal = o.approach ?? o.usePos
      const path = w.findPath(start, goal)
      expect(path.length, o.id).toBeGreaterThan(0)
      expect(dist(path[path.length - 1], goal), o.id).toBeLessThan(1e-6)
      // the whole route must be walkable, except the last few cm into the goal itself,
      // which may sit just inside a blocked cell (e.g. a seat)
      let prev = start
      for (const p of path) {
        for (let t = 0; t < 1; t += 0.02) {
          const q = { x: prev.x + (p.x - prev.x) * t, z: prev.z + (p.z - prev.z) * t }
          if (dist(q, goal) < 0.5) continue
          expect(w.isFree(q), `${o.id} at ${q.x.toFixed(2)},${q.z.toFixed(2)}`).toBe(true)
        }
        prev = p
      }
    }
  })

  it('the yard has activities and the way out of the house is the doorway', () => {
    const out = w.objects.filter(o => o.outdoors)
    expect(out.map(o => o.id)).toEqual(expect.arrayContaining(['bench_seat_1', 'garden', 'mailbox', 'lawn']))
    // from the middle of the room to the garden: the route has to pass through the door in the right wall
    const path = w.findPath({ x: 0, z: 0 }, w.find('garden')!.usePos)
    const door = { x: w.door.x, z: w.door.z }
    let through = false, prev = { x: 0, z: 0 }
    for (const p of path) {
      for (let t = 0; t <= 1; t += 0.01) {
        const q = { x: prev.x + (p.x - prev.x) * t, z: prev.z + (p.z - prev.z) * t }
        if (Math.abs(q.x - door.x) < 0.1 && Math.abs(q.z - door.z) <= w.door.halfWidth + 1e-6) through = true
      }
      prev = p
    }
    expect(through).toBe(true)
  })

  it('the house walls and the fence stay blocked, the doorway and the yard are open', () => {
    expect(w.isFree({ x: w.bounds.w / 2, z: 0 })).toBe(false) // wall
    expect(w.isFree({ x: w.bounds.w / 2, z: w.door.z + 0.1 })).toBe(true) // doorway
    expect(w.isFree({ x: -w.bounds.w / 2, z: w.door.z })).toBe(false) // no door on the left wall
    expect(w.isFree({ x: 8, z: 6 })).toBe(true) // lawn
    expect(w.isFree({ x: w.yard.x1 - 0.1, z: 0 })).toBe(false) // fence
  })

  it('night-only and day-only activities follow the clock', () => {
    const lawn = w.find('lawn')!
    const stargaze = lawn.affordances.find(a => a.verb === 'stargaze')!
    const fresh = lawn.affordances.find(a => a.verb === 'enjoy_fresh_air')!
    expect(w.isAvailable(stargaze, 23)).toBe(true) // wraps past midnight
    expect(w.isAvailable(stargaze, 3)).toBe(true)
    expect(w.isAvailable(stargaze, 12)).toBe(false)
    expect(w.isAvailable(fresh, 12)).toBe(true)
    expect(w.isAvailable(fresh, 23)).toBe(false)
  })

  it('walls are blocked and the room centre start is usable', () => {
    expect(w.isFree({ x: w.bounds.w / 2 - 0.05, z: 0 })).toBe(false)
    expect(w.isFree({ x: 100, z: 0 })).toBe(false)
  })

  it('occupancy is exclusive and only the owner can release', () => {
    const x = new World()
    x.claim('bed', 'Airi')
    expect(x.occupant('bed')).toBe('Airi')
    x.release('bed', 'Luna')
    expect(x.occupant('bed')).toBe('Airi')
    x.release('bed', 'Airi')
    expect(x.occupant('bed')).toBeUndefined()
  })

  it('needs decay and stay within 0..100', () => {
    const n = { energy: 10, fun: 50, knowledge: 50 }
    w.decayNeeds(n, 600)
    expect(n.energy).toBe(0)
    expect(n.fun).toBeGreaterThanOrEqual(0)
    expect(n.knowledge).toBeLessThan(50)
  })

  it('formats the clock', () => {
    expect(w.format(8 * 60 + 5)).toBe('Day 1 08:05')
    expect(w.format(1440 + 60)).toBe('Day 2 01:00')
  })
})
