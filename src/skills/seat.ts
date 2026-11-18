/**
 * Skill: sitting down on a seat and getting up (rule R0).
 *
 * Walk up to the seat's approach point, step forward until the calves are against the seat, turn round, and sit
 * down onto it. Getting up: stand up where one stood, and step back to the approach point. The body only moves
 * a short way while it sits down or stands up, and every other move is a walk, so nobody glides over the floor.
 */
import type { Vec2, WorldObject } from '../types'
import type { World } from '../world'
import { dist } from '../world'
import type { Step } from './index'

/** the calves touch the seat's front edge: the body's centre stays this far from the furniture */
const CALVES = 0.12
/** standing up, the body's centre is at least this far in front of where the hips are on the seat */
const STAND_OFF = 0.27

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

/** the steps from anywhere to sitting on the seat, ending with the activity itself */
export function sitDown(world: World, obj: WorldObject): Step[] {
  const front = seatFront(world, obj)
  return [
    { do: 'walk', to: { ...obj.approach! } },
    { do: 'squeeze', to: front },
    { do: 'face', heading: outward(obj), secs: 0.4 },
    { do: 'pose', pose: 'sit', at: { ...obj.usePos }, heading: outward(obj), secs: 0.8 },
    { do: 'use' },
  ]
}

/** the steps from sitting on the seat back to standing at its approach point */
export function standUp(world: World, obj: WorldObject, heading: number): Step[] {
  return [
    { do: 'pose', pose: 'stand', at: seatFront(world, obj), heading, secs: 0.8 },
    { do: 'squeeze', to: { ...obj.approach! } },
  ]
}
