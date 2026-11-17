/**
 * Skill: going to bed and getting up (rules R1 and R2).
 *
 * Lying down: walk to the side of the bed, turn your back to it, sit down on the edge, take the shoes off,
 * then lie down. Getting up is the same in reverse: sit up on the edge, put the shoes on, stand up, and step
 * back to the open floor. The bed's side is reached by a short squeeze along the bed that keeps clear of all
 * furniture, so nothing passes through anything (R0).
 */
import type { Affordance, Vec2, WorldObject } from '../types'
import type { World } from '../world'
import type { Step } from './index'

/** head towards -x on every bed and cot (the head end is at the wall); see agent.ts for lying down */
export const LIE_HEADING = Math.PI / 2
/** how far from the bed edge one stands, and how far in from it one sits */
const STAND_OUT = 0.32
const SIT_IN = 0.14
/** a body is about 0.4 m wide: the squeeze needs at least this clearance from furniture on its centre line */
export const BODY_CLEARANCE = 0.2

export interface Rect { cx: number; cz: number; w: number; d: number }

/** the bed's footprint: the furniture under the sleeping spot, or a camp-cot size around it */
export function bedRect(world: World, obj: WorldObject): Rect {
  const p = obj.usePos
  const under = world.obstacles
    .filter(f => Math.abs(p.x - f.cx) <= f.w / 2 && Math.abs(p.z - f.cz) <= f.d / 2 && f.w * f.d < 4)
    .sort((a, b) => a.w * a.d - b.w * b.d)[0]
  return under ?? { cx: p.x, cz: p.z, w: 1.9, d: 0.72 }
}

export interface Bedside {
  /** where to stand beside the bed */
  stand: Vec2
  /** where to sit on its edge */
  sit: Vec2
  /** facing away from the bed, for sitting on its edge */
  out: number
  /** the walk from the open floor to `stand`; the first point is on the navigation grid */
  way: Vec2[]
}

/**
 * Where to sit on the bed: the side with room to stand (the head is at -x, so the sides are the ±z edges),
 * near the foot end; if neither side has room, the foot end itself.
 */
export function bedside(world: World, obj: WorldObject): Bedside {
  const r = bedRect(world, obj)
  const foot = obj.approach ?? { x: r.cx + r.w / 2 + 0.45, z: r.cz }
  const x = r.cx + r.w / 2 - 0.55 // a little in from the foot end
  const sides = [1, -1]
    .map(side => {
      const edge = r.cz + side * r.d / 2
      const stand = { x, z: edge + side * STAND_OUT }
      const corner = { x: r.cx + r.w / 2 + STAND_OUT, z: edge + side * STAND_OUT }
      const way = [foot, corner, stand]
      const ok = world.clearance(stand) >= BODY_CLEARANCE &&
        way.every((p, i) => i === 0 || world.clearSegment(way[i - 1], p, BODY_CLEARANCE))
      return { side, edge, stand, way, ok, room: world.clearance(stand) }
    })
    .filter(s => s.ok)
    .sort((a, b) => b.room - a.room)
  const best = sides[0]
  if (best) {
    return { stand: best.stand, sit: { x, z: best.edge - best.side * SIT_IN }, out: best.side > 0 ? 0 : Math.PI, way: best.way }
  }
  // no room along either side: sit on the foot end, facing away from the bed
  return { stand: foot, sit: { x: r.cx + r.w / 2 - SIT_IN, z: r.cz }, out: LIE_HEADING, way: [foot] }
}

/** the steps from anywhere to lying in the bed, ending with the activity itself */
export function lieDown(world: World, obj: WorldObject, _aff: Affordance): Step[] {
  const b = bedside(world, obj)
  const [first, ...rest] = b.way
  return [
    { do: 'walk', to: first },
    ...rest.map((to): Step => ({ do: 'squeeze', to })),
    { do: 'face', heading: b.out, secs: 0.4 },
    { do: 'pose', pose: 'sit', at: b.sit, heading: b.out, secs: 0.8 },
    { do: 'act', motion: 'shoes', secs: 1.6, shoes: 'off' },
    { do: 'pose', pose: 'lie', at: obj.usePos, heading: LIE_HEADING, secs: 1.2 },
    { do: 'use' },
  ]
}

/** the steps from lying in the bed back to standing on the open floor */
export function getUp(world: World, obj: WorldObject): Step[] {
  const b = bedside(world, obj)
  const back = [...b.way].reverse().slice(1)
  return [
    { do: 'pose', pose: 'sit', at: b.sit, heading: b.out, secs: 1.0 },
    { do: 'act', motion: 'shoes', secs: 1.6, shoes: 'on' },
    { do: 'pose', pose: 'stand', at: b.stand, heading: b.out, secs: 0.8 },
    ...back.map((to): Step => ({ do: 'squeeze', to })),
  ]
}
