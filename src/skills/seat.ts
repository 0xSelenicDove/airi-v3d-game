/**
 * Skill: sitting down on a seat and getting up (rule R0).
 *
 * A seat one walks up to from the front (a sofa, an armchair, a bench): walk up to its approach point, step forward
 * until the calves are against the seat, turn round, and sit down onto it. Getting up: stand up where one stood,
 * and step back to the approach point.
 *
 * A chair or stool at a table is solid, and there is no room in front of it while it is pushed in. Walk up beside
 * it, pull it out by its top, step in between it and the table, sit down, and slide in with it. Getting up is the
 * same in reverse, and ends with pushing the chair back in.
 *
 * Sitting down and standing up keep the feet where they are while the hips swing over them (Agent.rise). Every
 * other move is a walk, so nobody glides over the floor.
 */
import type { TableChair, Vec2, Vec3, WorldObject } from '../types'
import type { World } from '../world'
import { dist } from '../world'
import type { Step } from './index'

/** the calves touch the seat's front edge: the body's centre stays this far from the furniture */
const CALVES = 0.12
/** standing up, the body's centre is at least this far in front of where the hips are on the seat */
const STAND_OFF = 0.27
/** how far a chair at a table slides out, so that one can stand between it and the table */
export const PULL = 0.45
/** how far the body moves over the feet while sitting down or standing up (at a table, or on a bed's edge) */
export const RISE_REACH = 0.3
/** standing beside a chair to pull it out: this far from its side */
const SIDE_GAP = 0.28

const offset = (p: Vec2, d: Vec2, k: number): Vec2 => ({ x: p.x + d.x * k, z: p.z + d.z * k })

/** how far the chair of `obj` (a seat at a table) is pulled out now, metres */
export const chairOut = (world: World, obj: WorldObject) => obj.chair ? world.chairOut.get(obj.chair.furniture) ?? 0 : 0

/** where a hand standing at `by` takes hold of a chair to pull it out or push it in: its top, near the back, at the near end */
export function chairTop(world: World, c: TableChair, by: Vec2): Vec3 {
  const across = { x: -c.out.z, z: c.out.x }
  const mid = offset(c.at, c.out, (world.chairOut.get(c.furniture) ?? 0) + c.d / 2 - 0.06)
  const k = (by.x - mid.x) * across.x + (by.z - mid.z) * across.z, end = c.w / 2 - 0.07
  const at = offset(mid, across, Math.max(-end, Math.min(end, k)))
  return { x: at.x, y: c.top - 0.02, z: at.z }
}

/** where one stands just in front of the seat, on the line from the seat to its approach point */
export function seatFront(world: World, obj: WorldObject): Vec2 {
  const to = obj.approach ?? obj.usePos
  const len = dist(obj.usePos, to)
  if (len < 1e-3) return { ...to }
  const dx = (to.x - obj.usePos.x) / len, dz = (to.z - obj.usePos.z) / len
  let r = STAND_OFF
  while (r < len && world.clearance({ x: obj.usePos.x + dx * r, z: obj.usePos.z + dz * r }) < CALVES) r += 0.02
  r = Math.min(r, len)
  return { x: obj.usePos.x + dx * r, z: obj.usePos.z + dz * r }
}

/** facing away from the seat's back, the way one sits on it */
const outward = (obj: WorldObject) => Math.atan2(obj.pos.x - obj.usePos.x, obj.pos.z - obj.usePos.z)

/** the places for using a chair at a table */
export interface ChairPlan {
  /** the hips on the pulled-out chair */
  seat: Vec2
  /** standing between the pulled-out chair and the table, where one sits down from and stands up to */
  stand: Vec2
  /** beside the pulled-out chair, level with `stand` */
  corner: Vec2
  /** beside the pulled-out chair, level with its middle: where one pulls it out and pushes it in */
  side: Vec2
  /** the heading from `side` to the chair */
  toChair: number
}

/** where to stand and sit for a chair at a table, on the side of the chair with the most room */
export function chairPlan(world: World, obj: WorldObject): ChairPlan {
  const c = obj.chair!
  const o = c.out, across = { x: -o.z, z: o.x }
  const seat = offset(obj.usePos, o, PULL)
  const stand = offset(seat, o, -RISE_REACH)
  const pulled = offset(c.at, o, PULL)
  const best = [1, -1]
    .map(s => {
      const k = s * (c.w / 2 + SIDE_GAP)
      const side = offset(pulled, across, k), corner = offset(stand, across, k)
      return { s, side, corner, room: Math.min(world.clearance(side), world.clearance(corner)) }
    })
    .sort((a, b) => b.room - a.room)[0]
  return { seat, stand, corner: best.corner, side: best.side, toChair: Math.atan2(-across.x * best.s, -across.z * best.s) }
}

/** the steps from anywhere to sitting on the seat, ending with the activity itself */
export function sitDown(world: World, obj: WorldObject): Step[] {
  const face = outward(obj)
  if (obj.chair) {
    const p = chairPlan(world, obj)
    return [
      { do: 'walk', to: { ...obj.approach! } },
      { do: 'squeeze', to: p.side },
      { do: 'face', heading: p.toChair, secs: 0.3 },
      { do: 'act', motion: 'move_chair', secs: 0.9, reach: 'chair', chairTo: PULL },
      { do: 'squeeze', to: p.corner },
      { do: 'squeeze', to: p.stand },
      { do: 'face', heading: face, secs: 0.3 },
      { do: 'pose', pose: 'sit', at: p.seat, heading: face, secs: 1.2 },
      { do: 'act', motion: 'move_chair', secs: 0.8, slide: { ...obj.usePos }, chairTo: 0 },
      { do: 'use' },
    ]
  }
  return [
    { do: 'walk', to: { ...obj.approach! } },
    { do: 'squeeze', to: seatFront(world, obj) },
    { do: 'face', heading: face, secs: 0.4 },
    { do: 'pose', pose: 'sit', at: { ...obj.usePos }, heading: face, secs: 1.2 },
    { do: 'use' },
  ]
}

/** the steps from sitting on the seat back to standing at its approach point */
export function standUp(world: World, obj: WorldObject): Step[] {
  const face = outward(obj)
  if (obj.chair) {
    const p = chairPlan(world, obj)
    return [
      { do: 'act', motion: 'move_chair', secs: 0.8, slide: p.seat, chairTo: PULL },
      { do: 'pose', pose: 'stand', at: p.stand, heading: face, secs: 1.2 },
      { do: 'squeeze', to: p.corner },
      { do: 'squeeze', to: p.side },
      { do: 'face', heading: p.toChair, secs: 0.3 },
      { do: 'act', motion: 'move_chair', secs: 0.9, reach: 'chair', chairTo: 0 },
      { do: 'squeeze', to: { ...obj.approach! } },
    ]
  }
  return [
    { do: 'pose', pose: 'stand', at: seatFront(world, obj), heading: face, secs: 1.2 },
    { do: 'squeeze', to: { ...obj.approach! } },
  ]
}
