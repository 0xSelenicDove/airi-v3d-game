/**
 * Skill: going to bed and getting up (rules R1 and R2).
 *
 * Lying down: walk to the side of the bed, turn your back to it, sit down on the edge, take the shoes off,
 * then lie down. Getting up is the same in reverse: sit up on the edge, put the shoes on, stand up, and step
 * back to the open floor. The bed's side is reached by a short squeeze along the bed that keeps clear of all
 * furniture, of other beds, and of the walls of a tent around the bed, so nothing passes through anything (R0).
 */
import type { Affordance, Footprint, Vec2, WorldObject } from '../types'
import type { World } from '../world'
import { dist } from '../world'
import type { Step } from './index'
import { RISE_REACH } from './seat'

/** head towards -x on every bed and cot (see agent.ts for lying down) */
export const LIE_HEADING = Math.PI / 2
/** how far from the bed edge one stands, and how far in from it one sits */
const STAND_OUT = 0.32
const SIT_IN = 0.14
/** how far in from the end of the bed one sits on its side */
const ALONG = 0.55
/** a body is about 0.4 m wide: the squeeze needs at least this clearance from furniture on its centre line */
export const BODY_CLEARANCE = 0.2
/** size of a bed without its own footprint (the camp cots: measured in public/models/outdoor.glb) */
const COT = { w: 2.0, d: 0.84 }

export type Rect = Footprint

const contains = (f: Rect, p: Vec2) => Math.abs(p.x - f.cx) <= f.w / 2 && Math.abs(p.z - f.cz) <= f.d / 2
const rectDist = (f: Rect, p: Vec2) =>
  Math.hypot(Math.max(0, Math.abs(p.x - f.cx) - f.w / 2), Math.max(0, Math.abs(p.z - f.cz) - f.d / 2))

/** something big that a bed stands inside, such as the tent; its footprint covers the whole floor inside it */
function enclosure(world: World, obj: WorldObject): Footprint | undefined {
  return world.obstacles.find(f => contains(f, obj.usePos) && f.w * f.d >= 4)
}

/** the bed's footprint: the furniture under the sleeping spot, or a cot-sized one around it */
export function bedRect(world: World, obj: WorldObject): Rect {
  const p = obj.usePos
  const under = world.obstacles
    .filter(f => contains(f, p) && f.w * f.d < 4)
    .sort((a, b) => a.w * a.d - b.w * b.d)[0]
  return under ?? { cx: p.x, cz: p.z, ...COT }
}

/**
 * Room around a point near a bed: furniture (ignoring an enclosure such as the tent), all beds in the same
 * enclosure, and the enclosure's walls except its open side (the side one comes in from).
 */
function room(world: World, obj: WorldObject) {
  const enc = enclosure(world, obj)
  const beds = enc
    ? world.objects.filter(o => o.affordances.some(a => a.pose === 'lie') && contains(enc, o.usePos)).map(o => bedRect(world, o))
    : []
  const from = obj.approach ?? obj.usePos
  // the open side of the enclosure faces the approach point
  const open = enc && (Math.abs(from.x - enc.cx) / enc.w > Math.abs(from.z - enc.cz) / enc.d
    ? (from.x < enc.cx ? 'x0' : 'x1') : (from.z < enc.cz ? 'z0' : 'z1'))
  return (p: Vec2) => {
    let d = world.clearance(p, enc ? [enc] : [])
    for (const b of beds) d = Math.min(d, rectDist(b, p))
    if (enc && contains(enc, p)) {
      const walls = { x0: p.x - (enc.cx - enc.w / 2), x1: enc.cx + enc.w / 2 - p.x, z0: p.z - (enc.cz - enc.d / 2), z1: enc.cz + enc.d / 2 - p.z }
      for (const [k, v] of Object.entries(walls)) if (k !== open) d = Math.min(d, v)
    }
    return d
  }
}

function clearWay(clearance: (p: Vec2) => number, way: Vec2[], min: number) {
  for (let i = 1; i < way.length; i++) {
    const a = way[i - 1], b = way[i], n = Math.max(1, Math.ceil(dist(a, b) / 0.05))
    for (let k = 0; k <= n; k++) {
      if (clearance({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n }) < min) return false
    }
  }
  return true
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
 * Where to sit on the bed: on a long side (the head is at -x, so the sides are the ±z edges), near the end one
 * comes from, on the side with the most room; if neither side has room, on that end itself.
 */
export function bedside(world: World, obj: WorldObject): Bedside {
  const r = bedRect(world, obj)
  const clearance = room(world, obj)
  // a tent is high enough to stand in only along its middle (its ridge), so in one, take the side facing it
  const enc = enclosure(world, obj)
  const score = (stand: Vec2) => enc ? -Math.abs(stand.z - enc.cz) : clearance(stand)
  const end = (obj.approach?.x ?? r.cx + 1) >= r.cx ? 1 : -1      // the end of the bed nearest the way in
  const endX = r.cx + end * r.w / 2
  const from = obj.approach ?? { x: endX + end * 0.45, z: r.cz }
  const x = endX - end * ALONG
  const sides = [1, -1]
    .map(side => {
      const edge = r.cz + side * r.d / 2
      const stand = { x, z: edge + side * STAND_OUT }
      const corner = { x: endX + end * STAND_OUT, z: edge + side * STAND_OUT }
      const way = [from, corner, stand]
      return { side, edge, stand, way, ok: clearance(stand) >= BODY_CLEARANCE && clearWay(clearance, way, BODY_CLEARANCE), room: score(stand) }
    })
    .filter(s => s.ok)
    .sort((a, b) => b.room - a.room)
  const best = sides[0]
  if (best) {
    return { stand: best.stand, sit: { x, z: best.edge - best.side * SIT_IN }, out: best.side > 0 ? 0 : Math.PI, way: best.way }
  }
  // no room along either side: walk up to the end of the bed and sit on it, facing away from the bed
  const stand = { x: endX + end * STAND_OUT, z: r.cz }
  return { stand, sit: { x: endX - end * SIT_IN, z: r.cz }, out: end > 0 ? Math.PI / 2 : -Math.PI / 2, way: [from, stand] }
}

/** the steps from anywhere to lying in the bed, ending with the activity itself */
export function lieDown(world: World, obj: WorldObject, _aff: Affordance): Step[] {
  const b = bedside(world, obj)
  const [first, ...rest] = b.way
  return [
    { do: 'walk', to: first },
    ...rest.map((to): Step => ({ do: 'squeeze', to })),
    { do: 'squeeze', to: overFeet(b) },
    { do: 'face', heading: b.out, secs: 0.4 },
    { do: 'pose', pose: 'sit', at: b.sit, heading: b.out, secs: 1.2 },
    { do: 'act', motion: 'shoes', secs: 3.2, shoes: 'off', reach: 'feet' },
    { do: 'pose', pose: 'lie', at: obj.usePos, heading: LIE_HEADING, secs: 2.0 },
    { do: 'use' },
  ]
}

/** the steps from lying in the bed back to standing on the open floor */
export function getUp(world: World, obj: WorldObject): Step[] {
  const b = bedside(world, obj)
  const back = [...b.way].reverse().slice(1)
  return [
    { do: 'pose', pose: 'sit', at: b.sit, heading: b.out, secs: 2.0 },
    { do: 'act', motion: 'shoes', secs: 3.2, shoes: 'on', reach: 'feet' },
    { do: 'pose', pose: 'stand', at: overFeet(b), heading: b.out, secs: 1.2 },
    { do: 'squeeze', to: b.stand },
    ...back.map((to): Step => ({ do: 'squeeze', to })),
  ]
}

/**
 * Standing just off the edge, over where the feet are while sitting on it: one sits down and stands up from here,
 * so the feet stay put (Agent.rise), and steps the rest of the way out to `stand`.
 */
export function overFeet(b: Bedside): Vec2 {
  const d = dist(b.sit, b.stand) || 1
  const k = Math.min(1, RISE_REACH / d)
  return { x: b.sit.x + (b.stand.x - b.sit.x) * k, z: b.sit.z + (b.stand.z - b.sit.z) * k }
}
